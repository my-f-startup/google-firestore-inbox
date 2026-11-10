import assert from "node:assert";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { getFirestoreEventStore } from "@emmett-community/emmett-google-firestore";
import { GenericContainer, Wait } from "testcontainers";
import { createFirestoreInbox } from "../src/inbox";
import { InboxBusyError } from "../src/support";
import type { ExternalEffect, InboxRecord, RecordInTransaction } from "../src/types";

const projectId = "demo-project";
const COLLECTION = "users-inbox";
const HANDLER = "userDataRemoval";
const LEASE_MS = 1000;

let emulator: import("testcontainers").StartedTestContainer | null = null;
let emulatorHost = "";
let emulatorPort = 0;
let firestore: Firestore;

const emulatorUrl = () => `http://${emulatorHost}:${emulatorPort}`;

const startEmulator = async () => {
  const container = await new GenericContainer("myfstartup/firebase-emulator-suite:15")
    .withPlatform("linux/amd64")
    .withExposedPorts(4000, 8080)
    .withBindMounts([
      {
        source: path.join(process.cwd(), "test", "firebase", "firebase.json"),
        target: "/app/firebase.json",
        mode: "ro" as const,
      },
      {
        source: path.join(process.cwd(), "test", "firebase", ".firebaserc"),
        target: "/app/.firebaserc",
        mode: "ro" as const,
      },
    ])
    .withEnvironment({ PROJECT_ID: projectId })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  emulatorHost = container.getHost();
  emulatorPort = container.getMappedPort(8080);

  return container;
};

const resetEmulator = async () => {
  const response = await fetch(`${emulatorUrl()}/emulator/v1/projects/${projectId}/databases/(default)/documents`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to reset Firestore emulator: ${response.status} ${response.statusText}`);
  }
};

void describe("google-firestore-inbox with the Firestore emulator", () => {
  let clock: number;

  before(async () => {
    emulator = await startEmulator();

    firestore = new Firestore({
      projectId,
      host: `${emulatorHost}:${emulatorPort}`,
      ssl: false,
      customHeaders: { Authorization: "Bearer owner" },
    });
  });

  after(async () => {
    await firestore?.terminate();
    await emulator?.stop();
  });

  beforeEach(async () => {
    await resetEmulator();
    clock = Date.now();
  });

  const inbox = () => createFirestoreInbox({ firestore, collection: COLLECTION, leaseMs: LEASE_MS, now: () => clock });

  const eventStore = () => getFirestoreEventStore(firestore);

  const appendRemoved = async (record: RecordInTransaction) => {
    await eventStore().appendToStream("user-1", [{ type: "UserDataRemoved", data: { userId: "user-1" } }], {
      beforeCommit: record,
    });
  };

  const recordOf = async (key: string) => (await firestore.collection(COLLECTION).doc(key).get()).data() as InboxRecord;

  // Feature: Handle a message once | Scenario: Two deliveries of the same message at the same time
  void it("lets only one of two simultaneous deliveries store its side effects", async () => {
    const results = await Promise.allSettled([
      inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved }),
      inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved }),
    ]);

    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof InboxBusyError);
    assert.strictEqual((await eventStore().readStream("user-1")).length, 1);
  });

  // Feature: Clean up handled messages | Scenario: A done record has the expiry date of the TTL policy
  void it("stores the expiry date of a done record as a Firestore timestamp", async () => {
    await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved });

    const record = await recordOf(`${HANDLER}:m1`);
    assert.strictEqual(record.state, "done");
    assert.ok(record.expiresAt instanceof Timestamp);
    assert.strictEqual(record.expiresAt.toMillis(), clock + 14 * 24 * 60 * 60 * 1000);
  });

  // Feature: Side effects outside Firestore | Scenario: A repeatable effect runs again after an interruption
  void it("resumes an interrupted record after the lease without repeating the Firestore side effects", async () => {
    let fail = true;
    const calls: string[] = [];
    const external: ExternalEffect[] = [
      {
        name: "deleteUser",
        class: "repeatable",
        run: () => {
          calls.push("deleteUser");
          if (fail) {
            fail = false;
            return Promise.reject(new Error("auth down"));
          }
          return Promise.resolve();
        },
      },
    ];
    await assert.rejects(
      inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved, external }),
      /auth down/
    );

    clock += LEASE_MS;
    const result = await inbox().handle({ handler: HANDLER, messageId: "m1", firestore: appendRemoved, external });

    assert.deepStrictEqual(result, { outcome: "resumed" });
    assert.deepStrictEqual(calls, ["deleteUser", "deleteUser"]);
    assert.strictEqual((await eventStore().readStream("user-1")).length, 1);
    assert.strictEqual((await recordOf(`${HANDLER}:m1`)).state, "done");
  });

  // Feature: Side effects outside Firestore | Scenario: A handling longer than the lease keeps it
  void it("renews the lease of a long effect, so a delivery during it waits", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const realTimeInbox = () =>
      createFirestoreInbox({ firestore, collection: COLLECTION, leaseMs: 2000, renewEveryMs: 500 });
    const calls: string[] = [];
    const external: ExternalEffect[] = [
      {
        name: "sendInvoice",
        class: "checkable",
        run: async () => {
          calls.push("run");
          await sleep(3000);
        },
        happened: () => Promise.resolve(false),
      },
    ];

    const first = realTimeInbox().handle({ handler: "billing", messageId: "m1", external });
    await sleep(2500);
    await assert.rejects(realTimeInbox().handle({ handler: "billing", messageId: "m1", external }), InboxBusyError);

    assert.deepStrictEqual(await first, { outcome: "handled" });
    assert.deepStrictEqual(calls, ["run"]);
    assert.strictEqual((await recordOf("billing:m1")).state, "done");
  });
});
