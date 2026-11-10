import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { Firestore } from "@google-cloud/firestore";
import { getFirestoreEventStore } from "@emmett-community/emmett-google-firestore";
import { InMemoryFirestore } from "@emmett-community/emmett-google-firestore/testing";
import { createFirestoreInbox } from "../src/inbox";
import { InboxBusyError, LeaseLostError, UnverifiableEffectError } from "../src/support";
import type { ExternalEffect, InboxOptions, InboxRecord, Logger, RecordInTransaction } from "../src/types";

const COLLECTION = "users-inbox";
const LEASE_MS = 1000;
const HANDLER = "userDataRemoval";

void describe("google-firestore-inbox with the in-memory Firestore", () => {
  let firestore: InMemoryFirestore;
  let clock: number;
  let warnings: string[];

  beforeEach(() => {
    firestore = new InMemoryFirestore();
    clock = 1_000_000;
    warnings = [];
  });

  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_context, message) => {
      warnings.push(message ?? "");
    },
    error: () => {},
  };

  const inbox = (overrides: Partial<InboxOptions> = {}) =>
    createFirestoreInbox({
      firestore: firestore as unknown as Firestore,
      collection: COLLECTION,
      leaseMs: LEASE_MS,
      now: () => clock,
      logger,
      ...overrides,
    });

  const eventStore = () => getFirestoreEventStore(firestore as unknown as Firestore);

  const streamLength = async (stream: string) => (await eventStore().readStream(stream)).length;

  const recordOf = async (key: string) =>
    (await firestore.collection(COLLECTION).get()).docs.find((doc) => doc.ref.id === key)?.data() as
      InboxRecord | undefined;

  const removed = { type: "UserDataRemoved", data: { userId: "user-1" } };

  const appendRemoved =
    (messageId = "m1") =>
    async (record: RecordInTransaction) => {
      await eventStore().appendToStream("user-1", [{ ...removed, metadata: { causationId: messageId } }], {
        beforeCommit: record,
      });
    };

  const effect = (name: string, effectClass: ExternalEffect["class"], calls: string[], failures = new Set<string>()) =>
    ({
      name,
      class: effectClass,
      run: ({ key }) => {
        calls.push(`${name}:${key}`);
        if (failures.has(name)) {
          failures.delete(name);
          return Promise.reject(new Error(`${name} failed`));
        }
        return Promise.resolve();
      },
    }) satisfies ExternalEffect;

  void describe("Firestore side effects", () => {
    // Feature: Handle a message once | Scenario: The record is stored with the Firestore side effects
    void it("stores the event and a done record in the same transaction", async () => {
      const result = await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() });

      assert.deepStrictEqual(result, { outcome: "handled" });
      assert.strictEqual(await streamLength("user-1"), 1);
      const record = await recordOf(`${HANDLER}:m1`);
      assert.strictEqual(record?.state, "done");
      assert.deepStrictEqual(record?.expiresAt, new Date(clock + 14 * 24 * 60 * 60 * 1000));
    });

    // Feature: Handle a message once | Scenario: A message delivered again is not handled again
    void it("does not handle a message again once it is done", async () => {
      await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() });

      const again = await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() });

      assert.deepStrictEqual(again, { outcome: "duplicate" });
      assert.strictEqual(await streamLength("user-1"), 1);
    });

    // Feature: Handle a message once | Scenario: Nothing is stored when the Firestore side effects fail
    void it("stores no record when the transaction of the side effects fails", async () => {
      await assert.rejects(
        inbox().handle({
          handler: HANDLER,
          messageId: "m1",
          firestore: () => Promise.reject(new Error("transaction failed")),
        }),
        /transaction failed/
      );

      assert.strictEqual(await recordOf(`${HANDLER}:m1`), undefined);

      const retry = await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() });
      assert.deepStrictEqual(retry, { outcome: "handled" });
    });

    // Feature: Handle a message once | Scenario: Two deliveries of the same message at the same time
    void it("lets only one of two simultaneous deliveries store its side effects", async () => {
      const results = await Promise.allSettled([
        inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() }),
        inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() }),
      ]);

      assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && rejected.reason instanceof InboxBusyError);
      assert.strictEqual(await streamLength("user-1"), 1);
    });

    // Feature: Handle a message once | Scenario: Each handler of a message has its own record
    void it("keeps one record per handler for the same message", async () => {
      await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved() });

      const other = await inbox().handle({ handler: "audit", messageId: "m1" });

      assert.deepStrictEqual(other, { outcome: "handled" });
      assert.strictEqual((await recordOf("audit:m1"))?.state, "done");
    });

    // Feature: Handle a message once | Scenario: Side effects that forget the record
    void it("writes the record on its own and warns when the side effects did not write it", async () => {
      const result = await inbox().handle({
        handler: HANDLER,
        messageId: "m1",
        firestore: async () => {
          await eventStore().appendToStream("user-1", [removed]);
        },
      });

      assert.deepStrictEqual(result, { outcome: "handled" });
      assert.strictEqual((await recordOf(`${HANDLER}:m1`))?.state, "done");
      assert.strictEqual(warnings.length, 1);
    });
  });

  void describe("Side effects outside Firestore", () => {
    // Feature: Side effects outside Firestore | Scenario: The record is done after the external effects
    void it("runs the external effects after the Firestore ones and then marks the record done", async () => {
      const calls: string[] = [];

      const result = await inbox().handle({
        handler: HANDLER,
        messageId: "m1",
        firestore: appendRemoved(),
        external: [effect("deleteUser", "repeatable", calls)],
      });

      assert.deepStrictEqual(result, { outcome: "handled" });
      assert.deepStrictEqual(calls, [`deleteUser:${HANDLER}:m1`]);
      const record = await recordOf(`${HANDLER}:m1`);
      assert.strictEqual(record?.state, "done");
      assert.deepStrictEqual(record?.completedEffects, ["deleteUser"]);
    });

    // Feature: Side effects outside Firestore | Scenario: A delivery during the lease waits
    void it("fails with InboxBusyError while the lease of an interrupted record lasts", async () => {
      const calls: string[] = [];
      const failures = new Set(["deleteUser"]);
      const external = [effect("deleteUser", "repeatable", calls, failures)];
      await assert.rejects(
        inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved(), external }),
        /deleteUser failed/
      );

      clock += LEASE_MS - 1;

      await assert.rejects(
        inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved(), external }),
        InboxBusyError
      );
      assert.strictEqual((await recordOf(`${HANDLER}:m1`))?.state, "processing");
    });

    // Feature: Side effects outside Firestore | Scenario: A repeatable effect runs again after an interruption
    void it("runs a repeatable effect again after the lease, without the Firestore side effects", async () => {
      const calls: string[] = [];
      const failures = new Set(["deleteUser"]);
      const external = [effect("deleteUser", "repeatable", calls, failures)];
      await assert.rejects(
        inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved(), external }),
        /deleteUser failed/
      );

      clock += LEASE_MS;
      const result = await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved(), external });

      assert.deepStrictEqual(result, { outcome: "resumed" });
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(await streamLength("user-1"), 1);
      assert.strictEqual((await recordOf(`${HANDLER}:m1`))?.state, "done");
    });

    // Feature: Side effects outside Firestore | Scenario: A keyed effect runs again with the same key
    void it("gives a keyed effect the same key every time", async () => {
      const calls: string[] = [];
      const failures = new Set(["charge"]);
      const external = [effect("charge", "keyed", calls, failures)];
      await assert.rejects(inbox().handle({ handler: "billing", messageId: "m1", external }), /charge failed/);

      clock += LEASE_MS;
      await inbox().handle({ handler: "billing", messageId: "m1", external });

      assert.deepStrictEqual(calls, ["charge:billing:m1", "charge:billing:m1"]);
    });

    // Feature: Side effects outside Firestore | Scenario: A checkable effect is checked before it runs again
    void it("does not run a checkable effect again when it already happened", async () => {
      const calls: string[] = [];
      let happened = false;
      const external: ExternalEffect[] = [
        {
          name: "sendEmail",
          class: "checkable",
          run: () => {
            calls.push("run");
            happened = true;
            return Promise.reject(new Error("timed out after sending"));
          },
          happened: () => Promise.resolve(happened),
        },
      ];
      await assert.rejects(inbox().handle({ handler: "mail", messageId: "m1", external }), /timed out/);

      clock += LEASE_MS;
      const result = await inbox().handle({ handler: "mail", messageId: "m1", external });

      assert.deepStrictEqual(result, { outcome: "resumed" });
      assert.deepStrictEqual(calls, ["run"]);
      assert.strictEqual((await recordOf("mail:m1"))?.state, "done");
    });

    // Feature: Side effects outside Firestore | Scenario: A checkable effect that did not happen runs again
    void it("runs a checkable effect again when it did not happen", async () => {
      const calls: string[] = [];
      const failures = new Set(["sendEmail"]);
      const external: ExternalEffect[] = [
        { ...effect("sendEmail", "checkable", calls, failures), happened: () => Promise.resolve(false) },
      ];
      await assert.rejects(inbox().handle({ handler: "mail", messageId: "m1", external }), /sendEmail failed/);

      clock += LEASE_MS;
      await inbox().handle({ handler: "mail", messageId: "m1", external });

      assert.strictEqual(calls.length, 2);
    });

    // Feature: Side effects outside Firestore | Scenario: An interrupted unverifiable effect is not run again
    void it("fails with UnverifiableEffectError and does not run an interrupted unverifiable effect", async () => {
      const calls: string[] = [];
      const failures = new Set(["notify"]);
      const external = [effect("notify", "unverifiable", calls, failures)];
      await assert.rejects(inbox().handle({ handler: "sms", messageId: "m1", external }), /notify failed/);

      clock += LEASE_MS;

      await assert.rejects(inbox().handle({ handler: "sms", messageId: "m1", external }), UnverifiableEffectError);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual((await recordOf("sms:m1"))?.state, "processing");
    });

    // Feature: Side effects outside Firestore | Scenario: Only the first pending effect can have been interrupted
    void it("runs an unverifiable effect that comes after the interrupted one", async () => {
      const calls: string[] = [];
      const failures = new Set(["deleteUser"]);
      const external = [effect("deleteUser", "repeatable", calls, failures), effect("notify", "unverifiable", calls)];
      await assert.rejects(inbox().handle({ handler: HANDLER, messageId: "m1", external }), /deleteUser failed/);

      clock += LEASE_MS;
      const result = await inbox().handle({ handler: HANDLER, messageId: "m1", external });

      assert.deepStrictEqual(result, { outcome: "resumed" });
      assert.deepStrictEqual(
        calls.map((call) => call.split(":")[0]),
        ["deleteUser", "deleteUser", "notify"]
      );
    });

    // Feature: Side effects outside Firestore | Scenario: A completed effect is not run again
    void it("does not run again an effect that completed before the interruption", async () => {
      const calls: string[] = [];
      const failures = new Set(["notify"]);
      const external = [effect("deleteUser", "repeatable", calls), effect("notify", "repeatable", calls, failures)];
      await assert.rejects(inbox().handle({ handler: HANDLER, messageId: "m1", external }), /notify failed/);

      clock += LEASE_MS;
      await inbox().handle({ handler: HANDLER, messageId: "m1", external });

      assert.deepStrictEqual(
        calls.map((call) => call.split(":")[0]),
        ["deleteUser", "notify", "notify"]
      );
    });

    // Feature: Side effects outside Firestore | Scenario: A person removes the record to run the message again
    void it("handles the message again when its record was removed", async () => {
      const calls: string[] = [];
      const failures = new Set(["notify"]);
      const external = [effect("notify", "unverifiable", calls, failures)];
      await assert.rejects(inbox().handle({ handler: "sms", messageId: "m1", external }), /notify failed/);
      await firestore.runTransaction((transaction) => {
        transaction.delete(firestore.collection(COLLECTION).doc("sms:m1"));
        return Promise.resolve();
      });

      const result = await inbox().handle({ handler: "sms", messageId: "m1", external });

      assert.deepStrictEqual(result, { outcome: "handled" });
      assert.strictEqual(calls.length, 2);
    });
  });

  void describe("Lease", () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const realTimeInbox = () => inbox({ leaseMs: 200, renewEveryMs: 50, now: Date.now });

    const slowEffect = (calls: string[], ms: number): ExternalEffect => ({
      name: "sendInvoice",
      class: "checkable",
      run: async () => {
        calls.push("run");
        await sleep(ms);
      },
      happened: () => Promise.resolve(false),
    });

    // Feature: Side effects outside Firestore | Scenario: A handling longer than the lease keeps it
    void it("keeps the lease while a long effect runs, so another delivery waits", async () => {
      const calls: string[] = [];
      const external = [slowEffect(calls, 500)];

      const first = realTimeInbox().handle({ handler: "billing", messageId: "m1", external });
      await sleep(300);
      await assert.rejects(realTimeInbox().handle({ handler: "billing", messageId: "m1", external }), InboxBusyError);

      assert.deepStrictEqual(await first, { outcome: "handled" });
      assert.deepStrictEqual(calls, ["run"]);
      assert.strictEqual((await recordOf("billing:m1"))?.state, "done");
    });

    // Feature: Side effects outside Firestore | Scenario: A delivery whose lease was taken over stops
    void it("does not overwrite the record when another delivery took the message over", async () => {
      const calls: string[] = [];
      const first = realTimeInbox().handle({ handler: "billing", messageId: "m1", external: [slowEffect(calls, 200)] });
      await sleep(50);
      await firestore.runTransaction(async (transaction) => {
        const ref = firestore.collection(COLLECTION).doc("billing:m1");
        const stored = (await transaction.get(ref)).data() as InboxRecord;
        transaction.set(ref, { ...stored, owner: "another-delivery", renewedAt: Date.now() });
      });

      await assert.rejects(first, LeaseLostError);

      const record = await recordOf("billing:m1");
      assert.strictEqual(record?.owner, "another-delivery");
      assert.strictEqual(record?.state, "processing");
    });

    // Feature: Side effects outside Firestore | Scenario: A handling that stops renewing loses the lease
    void it("lets another delivery resume once the renewals stop", async () => {
      const calls: string[] = [];
      const failures = new Set(["deleteUser"]);
      const external = [effect("deleteUser", "repeatable", calls, failures)];
      await assert.rejects(
        realTimeInbox().handle({ handler: HANDLER, messageId: "m1", external }),
        /deleteUser failed/
      );

      await sleep(250);
      const result = await realTimeInbox().handle({ handler: HANDLER, messageId: "m1", external });

      assert.deepStrictEqual(result, { outcome: "resumed" });
      assert.strictEqual(calls.length, 2);
    });
  });

  void describe("Clean up", () => {
    // Feature: Clean up handled messages | Scenario: A processing record does not expire
    void it("gives an expiry date only to a done record", async () => {
      const failures = new Set(["notify"]);
      const external = [effect("notify", "repeatable", [], failures)];
      await assert.rejects(inbox().handle({ handler: "sms", messageId: "m1", external }), /notify failed/);

      assert.strictEqual((await recordOf("sms:m1"))?.expiresAt, undefined);
    });

    // Feature: Clean up handled messages | Scenario: The expiry is configurable
    void it("sets the expiry date from the configured expiry", async () => {
      await inbox({ expiryMs: 5000 }).handle({ handler: "audit", messageId: "m1" });

      assert.deepStrictEqual((await recordOf("audit:m1"))?.expiresAt, new Date(clock + 5000));
    });
  });
});
