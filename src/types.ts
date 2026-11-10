import type { Firestore, Timestamp, Transaction } from "@google-cloud/firestore";

export interface Logger {
  debug(context: Record<string, unknown>, message?: string): void;
  info(context: Record<string, unknown>, message?: string): void;
  warn(context: Record<string, unknown>, message?: string): void;
  error(context: Record<string, unknown>, message?: string): void;
}

/**
 * How a side effect outside Firestore behaves when a delivery finds it interrupted.
 *
 * - `repeatable`: repeating it does not change the result, so it runs again.
 * - `keyed`: the external system accepts an idempotency key, so it runs again with the same key.
 * - `checkable`: it cannot be repeated, but the external system can be asked whether it happened.
 * - `unverifiable`: it cannot be repeated and cannot be checked, so it does not run again and the
 *   handling fails with `UnverifiableEffectError`.
 */
export type EffectClass = "repeatable" | "keyed" | "checkable" | "unverifiable";

export type EffectContext = {
  /** `<handler>:<messageId>`, the idempotency key of a keyed effect. */
  key: string;
};

export type ExternalEffect = {
  /** Unique within the handler. */
  name: string;
  class: EffectClass;
  run: (context: EffectContext) => Promise<void>;
  /** Required for a checkable effect: answers whether the effect already happened. */
  happened?: (context: EffectContext) => Promise<boolean>;
};

/** Writes the inbox record on a transaction. It can be passed as the `beforeCommit` hook of an append. */
export type RecordInTransaction = (transaction: Transaction) => void;

export type HandleOptions = {
  handler: string;
  messageId: string;
  /**
   * The side effects in Firestore. They are written in one transaction that also calls `record`,
   * for example as the `beforeCommit` option of an append.
   */
  firestore?: (record: RecordInTransaction) => Promise<void>;
  /** The side effects outside Firestore, run in order after the Firestore ones. */
  external?: readonly ExternalEffect[];
};

export type HandleOutcome = "handled" | "duplicate" | "resumed";

export type HandleResult = {
  outcome: HandleOutcome;
};

export type InboxOptions = {
  firestore: Firestore;
  collection: string;
  /**
   * How long a `processing` record belongs to the delivery that wrote it after its last renewal, in
   * milliseconds. A delivery that finds a record renewed less than this ago fails with
   * `InboxBusyError`; an older one is treated as interrupted.
   *
   * @default 60000
   */
  leaseMs?: number;
  /**
   * How often the delivery that owns a record renews its lease while the external effects run, in
   * milliseconds. It must be shorter than `leaseMs`.
   *
   * @default leaseMs / 2
   */
  renewEveryMs?: number;
  /**
   * How long a `done` record is kept, in milliseconds, through the `expiresAt` field of a Firestore
   * TTL policy. It must be longer than the message retention of the subscription.
   *
   * @default 1209600000 (14 days)
   */
  expiryMs?: number;
  /** @default Date.now */
  now?: () => number;
  logger?: Logger;
};

export type Inbox = {
  handle: (options: HandleOptions) => Promise<HandleResult>;
};

export type InboxRecord = {
  handler: string;
  messageId: string;
  state: "processing" | "done";
  /** Id of the delivery that owns the record. */
  owner: string;
  startedAt: number;
  /** Last renewal of the lease, in milliseconds. */
  renewedAt: number;
  completedEffects: string[];
  doneAt?: number;
  expiresAt?: Date | Timestamp;
};
