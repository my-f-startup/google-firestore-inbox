import { randomUUID } from "node:crypto";
import type { DocumentReference, Transaction } from "@google-cloud/firestore";
import {
  InboxBusyError,
  LeaseLostError,
  UnverifiableEffectError,
  assertValidEffects,
  inboxKey,
  isAlreadyExists,
} from "./support";
import type {
  ExternalEffect,
  HandleOptions,
  HandleResult,
  Inbox,
  InboxOptions,
  InboxRecord,
  RecordInTransaction,
} from "./types";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

type Renewal = { stop: () => Promise<void>; lost: () => boolean };

export const createFirestoreInbox = (options: InboxOptions): Inbox => {
  const {
    firestore,
    collection,
    logger,
    leaseMs = DEFAULT_LEASE_MS,
    expiryMs = DEFAULT_EXPIRY_MS,
    now = Date.now,
  } = options;
  const renewEveryMs = options.renewEveryMs ?? Math.floor(leaseMs / 2);

  const refOf = (key: string) => firestore.collection(collection).doc(key);

  const read = (ref: DocumentReference) =>
    firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      return snapshot.exists ? (snapshot.data() as InboxRecord) : undefined;
    });

  /** Writes the record only while this delivery still owns it. */
  const writeIfOwner = async (ref: DocumentReference, key: string, record: InboxRecord) => {
    const written = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const stored = snapshot.data() as InboxRecord | undefined;
      if (stored?.owner !== record.owner || stored?.state === "done") return false;
      transaction.set(ref, record);
      return true;
    });
    if (!written) throw new LeaseLostError(key);
  };

  const done = (record: InboxRecord): InboxRecord => ({
    ...record,
    state: "done",
    doneAt: now(),
    expiresAt: new Date(now() + expiryMs),
  });

  const newRecord = (handler: string, messageId: string, external: readonly ExternalEffect[]): InboxRecord => {
    const startedAt = now();
    const record: InboxRecord = {
      handler,
      messageId,
      state: "processing",
      owner: randomUUID(),
      startedAt,
      renewedAt: startedAt,
      completedEffects: [],
    };
    return external.length === 0 ? done(record) : record;
  };

  /** Keeps the lease of this delivery while its effects run, and notices when another delivery took it. */
  const startRenewal = (ref: DocumentReference, key: string, owner: string): Renewal => {
    let lost = false;
    let stopped = false;
    let inFlight: Promise<void> | undefined;

    const renew = async () => {
      try {
        await firestore.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          const stored = snapshot.data() as InboxRecord | undefined;
          if (stored?.owner !== owner || stored.state === "done") {
            lost = true;
            return;
          }
          transaction.set(ref, { ...stored, renewedAt: now() });
        });
      } catch (error) {
        logger?.warn({ key, err: error }, "Failed to renew the lease of the inbox record");
      }
    };

    const timer = setInterval(() => {
      if (stopped || lost || inFlight) return;
      inFlight = renew().finally(() => {
        inFlight = undefined;
      });
    }, renewEveryMs);
    timer.unref?.();

    const stop = async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    };

    return { stop, lost: () => lost };
  };

  /** Takes over an interrupted record, or tells why it cannot. */
  const claim = async (ref: DocumentReference, key: string) => {
    const result = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return { status: "missing" as const };

      const record = snapshot.data() as InboxRecord;
      if (record.state === "done") return { status: "done" as const };
      if (now() - (record.renewedAt ?? record.startedAt) < leaseMs) return { status: "busy" as const };

      const claimed: InboxRecord = { ...record, owner: randomUUID(), renewedAt: now() };
      transaction.set(ref, claimed);
      return { status: "claimed" as const, record: claimed };
    });
    if (result.status === "busy") throw new InboxBusyError(key);
    return result;
  };

  const runExternal = async (
    ref: DocumentReference,
    key: string,
    effects: readonly ExternalEffect[],
    start: InboxRecord,
    resuming: boolean
  ): Promise<void> => {
    const renewal = startRenewal(ref, key, start.owner);
    let record = start;
    let mayBeInterrupted = resuming;

    try {
      for (const effect of effects) {
        if (record.completedEffects.includes(effect.name)) continue;
        if (renewal.lost()) throw new LeaseLostError(key);

        const context = { key };
        const interrupted = mayBeInterrupted;
        mayBeInterrupted = false;

        if (interrupted && effect.class === "unverifiable") {
          logger?.error({ key, effect: effect.name }, "Interrupted unverifiable effect");
          throw new UnverifiableEffectError(key, effect.name);
        }

        const alreadyHappened = interrupted && effect.class === "checkable" && (await effect.happened!(context));
        if (!alreadyHappened) await effect.run(context);

        record = { ...record, completedEffects: [...record.completedEffects, effect.name] };
        await writeIfOwner(ref, key, record);
      }

      await writeIfOwner(ref, key, done(record));
    } finally {
      await renewal.stop();
    }
  };

  const handleNew = async (
    ref: DocumentReference,
    key: string,
    { handler, messageId, firestore: firestoreEffects, external = [] }: HandleOptions
  ): Promise<HandleResult> => {
    const record = newRecord(handler, messageId, external);
    let recorded = false;
    const recordIn: RecordInTransaction = (transaction: Transaction) => {
      recorded = true;
      transaction.create(ref, record);
    };

    try {
      if (firestoreEffects) await firestoreEffects(recordIn);
      if (!recorded) {
        if (firestoreEffects) {
          logger?.warn({ key }, "The Firestore effects did not write the inbox record; it is written on its own");
        }
        await firestore.runTransaction((transaction) => {
          recordIn(transaction);
          return Promise.resolve();
        });
      }
    } catch (error) {
      if (isAlreadyExists(error)) throw new InboxBusyError(key);
      throw error;
    }

    if (external.length > 0) await runExternal(ref, key, external, record, false);
    return { outcome: "handled" };
  };

  const handle = async (handleOptions: HandleOptions): Promise<HandleResult> => {
    const external = handleOptions.external ?? [];
    assertValidEffects(external);

    const key = inboxKey(handleOptions.handler, handleOptions.messageId);
    const ref = refOf(key);
    const existing = await read(ref);

    if (existing?.state === "done") return { outcome: "duplicate" };

    if (existing) {
      const claimed = await claim(ref, key);
      if (claimed.status === "done") return { outcome: "duplicate" };
      if (claimed.status === "claimed") {
        logger?.info({ key }, "Resuming an interrupted message");
        await runExternal(ref, key, external, claimed.record, true);
        return { outcome: "resumed" };
      }
    }

    return handleNew(ref, key, handleOptions);
  };

  return { handle };
};
