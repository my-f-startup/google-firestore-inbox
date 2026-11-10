# @my-f-startup/google-firestore-inbox

Inbox for Google Firestore.

Handles each delivered message once per handler. The record of the message is written in the same Firestore transaction as the side effects of the handler, so a message delivered again does not repeat them, and each side effect outside Firestore declares how it behaves when a handling is interrupted. It depends on neither an event sourcing framework nor a message broker. Includes unit, integration (in-memory Firestore), and E2E tests with the Firestore emulator via Testcontainers.

---

## Why this exists

A broker that delivers at least once can deliver the same message twice, to the same consumer or to another replica. Without protection, the handler runs twice and its side effects happen twice.

The record of the handled message must be written together with the side effects. If it is written before them and the process stops, the side effects never happen; if it is written after them, they happen again. Firestore writes can share one transaction with the record, so they happen once. A side effect outside Firestore, such as deleting an account in another system, sending an email or charging a card, cannot take part in that transaction, so exactly once is not possible for it. This package makes each such effect declare its class, and the class decides what a delivery does when it finds the effect interrupted.

---

## Features

- ✅ **Atomic with the Firestore side effects** – the record is created in their transaction, for example as the `beforeCommit` hook of an append
- ✅ **No read in the transaction** – the record is written with `create`, so of two simultaneous deliveries only one stores its side effects
- ✅ **One record per handler** – several handlers of one message deduplicate on their own
- ✅ **Classes of external side effects** – `repeatable`, `keyed`, `checkable` and `unverifiable`
- ✅ **Renewed lease** – the delivery that owns a message renews its lease while the effects run, so a long effect is not taken over, and a process that stops frees it after one lease
- ✅ **Failures are not hidden** – an interrupted effect that cannot be checked or repeated fails the delivery instead of running again
- ✅ **Clean up by TTL** – a handled record carries the `expiresAt` date of a Firestore TTL policy

---

## Installation

```bash
npm install @my-f-startup/google-firestore-inbox
```

### Peer Dependencies

- `@google-cloud/firestore` ^7.10.0

---

## Quick Start

```ts
import { Firestore } from "@google-cloud/firestore";
import { createFirestoreInbox } from "@my-f-startup/google-firestore-inbox";

const firestore = new Firestore({ projectId: "demo-project" });

const inbox = createFirestoreInbox({ firestore, collection: "orders-inbox" });

await inbox.handle({
  handler: "orderShipping",
  messageId: message.messageId,
  firestore: (record) =>
    firestore.runTransaction(async (transaction) => {
      transaction.set(firestore.collection("shipments").doc(orderId), { status: "requested" });
      record(transaction);
    }),
  external: [
    {
      name: "notifyCarrier",
      class: "keyed",
      run: ({ key }) => carrier.requestPickup(orderId, { idempotencyKey: key }),
    },
  ],
});
```

### With an event store

`record` only writes to the transaction it receives, so it can be passed as a hook that runs inside the transaction of an append:

```ts
await inbox.handle({
  handler: "userDataRemoval",
  messageId,
  firestore: (record) => eventStore.appendToStream(userId, [userDataRemoved], { beforeCommit: record }),
  external: [{ name: "deleteAccount", class: "repeatable", run: () => deleteAccount(userId) }],
});
```

---

## Mental model

### 1. Read the record

- `<collection>/<handler>:<messageId>`
- `done`: the message was handled, nothing runs (`outcome: "duplicate"`)
- `processing` and renewed less than `leaseMs` ago: another delivery is still working, so `InboxBusyError` is thrown
- `processing` and not renewed for longer than `leaseMs`: the handling was interrupted, so this delivery takes the record over and resumes it (`outcome: "resumed"`)
- missing: the message is handled from the start (`outcome: "handled"`)

### 2. Firestore side effects and the record

- `firestore(record)` runs your transaction, which calls `record(transaction)`
- The record is created as `processing` when there are external effects, or as `done` when there are none
- If the record already exists, the transaction fails and `InboxBusyError` is thrown: another delivery stored its side effects

### 3. External side effects

- Run in order, after the Firestore ones
- While they run, the lease is renewed every `renewEveryMs`
- Each completed effect is added to `completedEffects` of the record
- When all completed, the record becomes `done` and gets its `expiresAt` date
- Each of these writes checks that the delivery still owns the record. If another delivery took it over, nothing is written and `LeaseLostError` is thrown

### 4. Resuming an interrupted handling

The effects listed in `completedEffects` do not run again. The first effect that did not complete may have been interrupted, and its class decides:

| Class | On resume |
| --- | --- |
| `repeatable` | Runs again |
| `keyed` | Runs again with the same `key` |
| `checkable` | Runs again only if `happened` answers `false` |
| `unverifiable` | Does not run; `UnverifiableEffectError` is thrown |

The effects after it had not started, so they run normally. The Firestore side effects never run again: they were committed with the record.

---

## API

### `createFirestoreInbox(options)`

**Options:**

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `firestore` | `Firestore` | required | The Firestore instance, the same one that runs the transactions |
| `collection` | `string` | required | Collection that holds the records |
| `leaseMs` | `number` | `60000` | How long a `processing` record belongs to its delivery after the last renewal |
| `renewEveryMs` | `number` | `leaseMs / 2` | How often the lease is renewed while the external effects run. It must be shorter than `leaseMs` |
| `expiryMs` | `number` | `1209600000` (14 days) | How long a `done` record is kept, through `expiresAt`. It must be longer than the message retention of the subscription, or a late duplicate finds no record |
| `now` | `() => number` | `Date.now` | Clock in milliseconds, for tests |
| `logger` | `Logger` | none | Warned when the Firestore side effects did not write the record |

**Returns:** `{ handle }`

### `handle(options)`

| Property | Type | Description |
| --- | --- | --- |
| `handler` | `string` | Name of the handler, part of the key |
| `messageId` | `string` | Identity of the message, stable across deliveries |
| `firestore` | `(record) => Promise<void>` | Optional. Runs the Firestore side effects in one transaction that calls `record(transaction)` |
| `external` | `ExternalEffect[]` | Optional. The side effects outside Firestore, in order |

An `ExternalEffect` has a unique `name`, a `class`, `run({ key })` and, for a checkable effect, `happened({ key })`. The `key` is `<handler>:<messageId>`.

**Returns:** `Promise<{ outcome: "handled" | "duplicate" | "resumed" }>`

**Throws:** `InboxBusyError` when another delivery holds the message, `LeaseLostError` when another delivery took the message over while this one was handling it, `UnverifiableEffectError` for an interrupted unverifiable effect, and the error of a side effect that fails. In every case the message should be delivered again later (a negative acknowledgement), so the broker retries it and, after its retry budget, sends it to its dead letter topic.

If `firestore` does not call `record`, the record is written on its own, outside the transaction of the side effects, and a warning is logged. A test that delivers the same message twice finds that mistake.

---

## Stored record

```text
<collection>/<handler>:<messageId>
  handler: string
  messageId: string
  state: "processing" | "done"
  owner: string (id of the delivery that owns the record)
  startedAt: number (milliseconds)
  renewedAt: number (milliseconds, last renewal of the lease)
  completedEffects: string[]
  doneAt: number (milliseconds, when done)
  expiresAt: timestamp (when done)
```

Create a Firestore TTL policy on the `expiresAt` field of the collection. A `processing` record has no `expiresAt`, so it is never removed by the policy: it is what keeps an interrupted effect from running again. A person resolves an interrupted unverifiable effect by marking the record `done` when the effect happened, or by removing it when it did not, which lets the next delivery handle the message from the start.

---

## Testing philosophy

- **Unit tests** – Pure logic
- **Integration tests** – In-memory Firestore from `@emmett-community/emmett-google-firestore/testing`, with that event store as the source of the Firestore side effects
- **E2E tests** – Real Firestore emulator via Testcontainers, including two simultaneous deliveries of one message and a delivery during a long effect

### Emulator image for E2E tests

The E2E suite uses the Docker image `myfstartup/firebase-emulator-suite:15` via Testcontainers.
The container expects `PROJECT_ID` and supports mounting `firebase.json` and `.firebaserc` into `/app` for configuration.

---

## Tests

- Lint: `npm run lint`
- Format check: `npm run format:check`
- Unit: `npm run test:unit`
- Integration (in-memory): `npm run test:int`
- E2E (Firestore emulator): `npm run test:e2e`
- All tests: `npm test`

---

## Build & Runtime

- Build JS: `npm run build` (outputs `dist/`)

---

## Compatibility

- Node.js: >= 20
- Firestore client: `@google-cloud/firestore` ^7.10.0

---

## Non-goals

- Consuming messages from a broker or acknowledging them
- Exactly once for an effect outside Firestore that cannot be repeated, checked or keyed: it is reported, not solved
- Creating the TTL policy, which belongs to infrastructure code

---

## Changelog

The [CHANGELOG.md](CHANGELOG.md) file is **automatically generated** during pull requests. Do not edit it manually.

### How it works

A GitHub Actions workflow runs [git-chglog](https://github.com/git-chglog/git-chglog) to generate the changelog from commit messages. Only commits following the [Conventional Commits](https://www.conventionalcommits.org/) format are included.

### Commit format

```text
<type>(<scope>): <description>
```

- **type**: Required. One of `feat`, `fix`, `refactor`, `perf`
- **scope**: Optional. Component or area affected (e.g., `inbox`, `support`)
- **description**: Required. Short summary of the change

### Recognized commit types

| Type       | Changelog section |
| ---------- | ----------------- |
| `feat`     | Added             |
| `fix`      | Fixed             |
| `refactor` | Changed           |
| `perf`     | Changed           |

Other types (`chore`, `docs`, `test`, `style`, `ci`, `build`) are not included in the changelog.

---

Made with ❤️ by My F* Startup
