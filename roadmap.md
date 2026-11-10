# Roadmap

Work planned for this library, driven by the rules of the my-f-startup reference architecture (idempotent consumers: ADR-002; side effects of subscribers: ADR-013). The library stays generic: it depends on neither an event sourcing framework nor a message broker.

Legend: Done, Partial, Open, Not verified.

| Item | Status | Evidence and note |
|---|---|---|
| Record in the transaction of the Firestore side effects, with `create` and the key `<handler>:<messageId>` | Done | `createFirestoreInbox().handle` with the `record` function passed to the Firestore effects (0.1.0). Covered by integration tests on the in-memory Firestore and end to end tests on the emulator, including two simultaneous deliveries |
| Classes of side effects outside Firestore, `processing` and `done` states, lease | Done | `repeatable`, `keyed`, `checkable` and `unverifiable`, with `completedEffects` so that only the first pending effect is treated as interrupted (0.1.0) |
| `expiresAt` for a Firestore TTL policy | Done | Set on a `done` record only, 14 days by default (0.1.0). The policy itself belongs to infrastructure code |
| Lint and format check in CI | Done | `build_and_test` runs `lint` and `format:check` before the tests (0.1.0) |
| Publish the first version and make the services use it | Open | The user-service subscriber is the first dependent |
| The lease of a long handling | Done | The owner of a record renews its lease every `renewEveryMs` while the external effects run, and every write checks the owner, so a long effect is not taken over and a delivery that lost the record writes nothing (0.1.0). A delivery paused longer than the lease can still lose the record while its effect runs |
| Duration of transactions under contention on the emulator | Not verified | On the emulator, two deliveries competing for one record take several seconds, while the effect itself takes milliseconds. Not measured against a real Firestore |
| A record left `processing` by a resolved failure | Not verified | When a failure is not a crash, the next delivery within the lease fails as busy until the lease ends. How this combines with the retry backoff of the subscription was not measured |
