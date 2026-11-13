# Outbox reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No trip event stays unpublished for more than about two minutes: a pending marker on every outbox item, cleared by the stream publisher, and a scheduled reconciler that publishes whatever is still pending, with a live demo.

**Architecture:** The outbox item gets sparse GSI2 keys (`OUTBOX#<shard>`) in the same transaction that writes it. The stream publisher clears them after PutEvents accepts the entry. A new `reconciler` Lambda runs every minute, queries the 10 shards for markers older than 60 s, publishes them with the same entry builder and chunking as the publisher, and clears the accepted ones.

**Tech Stack:** Node 26, TypeScript, AWS SDK v3 (DynamoDB DocumentClient, EventBridge), osls (`serverless.yml`), Vitest (unit / integration on Floci / e2e), Floci.

**Spec:** `docs/design/2026-11-12-outbox-reconciler-design.md`

## Global Constraints

- Node 26, TypeScript, existing patterns: `createX(deps)` + lazy `handler`, `jsonLog`.
- The event body must not change: `Detail` is every item attribute except `PK`, `SK`, `entity`, `GSI2PK`, `GSI2SK`, `publishedAt`.
- `GSI2PK = OUTBOX#<shard>`, shard = stable hash of `tripId` mod `OUTBOX_SHARDS` (10); `GSI2SK = <occurredAt>#<tripId>#<version padded 6>`.
- Clear = `UpdateItem REMOVE GSI2PK, GSI2SK SET publishedAt`, `ConditionExpression: attribute_exists(PK)`; a missing item is ignored.
- Reconciler: schedule every 1 minute, age threshold 60 s, cap 500 events per run split fairly: 50 per shard, the run starting at shard `minuteOfHour % 10` (rotation), a failing shard never blocks the others. PutEvents ≤ 10 per call, never two events of one trip in a call.
- Scope: recovery covers events written after this deploys (only they carry the marker). Older lost events are out of scope; say so in ADR 0008.
- "About two minutes" is an objective, not a guarantee (caps, retries, GSI eventual consistency, schedule delay); ADR 0008 says so.
- A failed clear never fails the stream batch: log and move on.
- Docs in `docs/design/` and `docs/plans/`; no tool names in paths. Commits without `Co-Authored-By`; no push without the owner's order. Public repo: no client or employer names.
- Peak load rerun is optional (owner, 2026-11-13).

## Review Focus

1. A stream event whose clear fails, then the reconciler runs: the event is published twice and the consumers' duplicate guards absorb it (no double billing). Pinned in Task 4 (publisher survives failed clear) and Task 5 (reconciler republishes); consumer dedup already tested.
2. Trip reads must not change: the outbox item now carries GSI2 keys, and besides the publisher and reconciler only `scripts/load/check.ts:201-205` reads outbox items, and only their versions (harmless; checked). Pinned in Task 2 (`TripRepo.get` has no `GSI2PK`) and Task 1 (golden `Detail`).
3. A pending item deleted or never written between the query and the clear: the clear's condition fails and must be ignored, not thrown. Pinned in Task 3.
4. A backlog or a permanently failing shard: other shards are still published every run (fair budget, rotation, per-shard isolation). Pinned in Task 5 (`a failing shard does not starve the others`) and Task 3 (pagination with forced `LastEvaluatedKey`).
5. The demo stopped with Ctrl-C or failing midway: the publisher's stream mapping must be enabled again. Pinned in Task 7 (`withStreamDisabled` test).

---

### Task 1: One entry builder for both paths

**Files:**
- Create: `src/events/outbox-entry.ts`
- Modify: `src/events/publisher.ts` (use the builder; make `chunkEntries` generic)
- Test: `tests/unit/events/outbox-entry.test.ts`, existing `tests/unit/events/publisher.test.ts`

**Interfaces:**
- Produces: `type OutboxKey = { PK: string; SK: string }`; `type BuiltEntry = { key: OutboxKey; tripId: string; correlationId?: string; entry: PutEventsRequestEntry }`; `buildEntry(item: Record<string, unknown>, busName: string): BuiltEntry`; `chunkEntries<T extends { tripId: string }>(entries: T[]): T[][]` (same behavior as today). `OutboxEntry` becomes `BuiltEntry & { sequenceNumber: string }`.

- [ ] **Step 1: Write the failing tests** in `outbox-entry.test.ts`:
  - `golden Detail`: for the fixed item `{ schemaVersion:1, eventId:'t-1:1', type:'trip.requested', tripId:'t-1', version:1, occurredAt:'2026-11-10T12:00:00.000Z', payload:{fromState:null,toState:'REQUESTED',passengerId:'p-1',fareEstimate:7000}, correlationId:'c-1', PK:'TRIP#t-1', SK:'EVENT#000001', entity:'EVENT' }`, `Detail` equals the exact JSON string the publisher produces today (copy it from a run of the current `outboxEntries` before refactoring).
  - `strips index and debug attributes`: the same item plus `GSI2PK`, `GSI2SK`, `publishedAt` gives the identical `Detail`, and `key` is `{ PK:'TRIP#t-1', SK:'EVENT#000001' }`.
- [ ] **Step 2: Run** — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `buildEntry` (the stripping set is exactly the six names in Global Constraints) and switch `outboxEntries` to it.
- [ ] **Step 4: Run** `make test` — Expected: new tests and all existing publisher tests PASS unchanged.
- [ ] **Step 5: Commit** `refactor: shared outbox entry builder, strips index attributes`

### Task 2: Pending marker on the outbox item

**Files:**
- Modify: `src/infra/dynamo/keys.ts` (next to `outboxKey`, line ~73)
- Modify: `src/infra/dynamo/trip-repo.ts:218-226` (`putOutbox`)
- Test: `tests/unit/infra/keys.test.ts`, `tests/integration/trip-repo.test.ts`

**Interfaces:**
- Produces: `OUTBOX_SHARDS = 10`; `outboxShard(tripId: string): number`; `outboxPendingPk(shard: number): string` (`OUTBOX#<shard>`); `outboxPendingGsi2(tripId: string, occurredAt: string, version: number): { GSI2PK: string; GSI2SK: string }`.

- [ ] **Step 1: Write the failing unit tests** in `keys.test.ts`:
  - `outboxShard is stable and in range`: same id → same shard twice; 1000 random UUIDs all in `[0, 9]`; at least 8 distinct shards among them.
  - `outboxPendingGsi2 keys`: `outboxPendingGsi2('t-1', '2026-11-13T10:00:00.000Z', 3)` → `{ GSI2PK: \`OUTBOX#${outboxShard('t-1')}\`, GSI2SK: '2026-11-13T10:00:00.000Z#t-1#000003' }`.
- [ ] **Step 2: Run** `npx vitest run --project unit tests/unit/infra/keys.test.ts` — Expected: FAIL (not exported).
- [ ] **Step 3: Implement** in `keys.ts`. `outboxShard`: FNV-1a 32-bit over the UTF-8 bytes of `tripId`, unsigned, `% OUTBOX_SHARDS`. Then in `putOutbox` spread `outboxPendingGsi2(event.tripId, event.occurredAt, event.version)` into the item.
- [ ] **Step 4: Add the integration test** in `trip-repo.test.ts`: `a new outbox event is in the pending index` — create a trip, query GSI2 with `GSI2PK = outboxPendingPk(outboxShard(trip.id))` and keep the items whose `tripId` is `trip.id`; expect exactly the `EVENT#000001` item, with `GSI2SK` = `outboxPendingGsi2(trip.id, <its occurredAt>, 1).GSI2SK`. Also assert `deps.trips.get(trip.id)` has no `GSI2PK`.
- [ ] **Step 5: Run** `make test` and `npx vitest run --project integration tests/integration/trip-repo.test.ts` (Floci up) — Expected: PASS.
- [ ] **Step 6: Commit** `feat: pending marker (sparse GSI2) on outbox items`

### Task 3: Outbox store (pending query and clear)

**Files:**
- Create: `src/infra/dynamo/outbox-store.ts`
- Test: `tests/integration/outbox-store.test.ts`

**Interfaces:**
- Consumes: `outboxPendingPk`, `OUTBOX_SHARDS`, `GSI2` from Task 2; `OutboxKey` from Task 1.
- Produces: `createOutboxStore(doc: DynamoDBDocumentClient, table: string): OutboxStore` with
  `pending(shard: number, before: string, limit: number): Promise<Record<string, unknown>[]>` (GSI2, `GSI2PK = OUTBOX#shard AND GSI2SK < :before`, ascending, follows `LastEvaluatedKey` until `limit` items or no more pages) and
  `clear(key: OutboxKey, publishedAt: string): Promise<void>` (REMOVE `GSI2PK, GSI2SK`, SET `publishedAt`, condition `attribute_exists(PK)`; `ConditionalCheckFailedException` → return).

- [ ] **Step 1: Write the failing integration tests** (test table via `createTestTable`):
  - `pending returns only markers older than the cut, oldest first` (three items with `occurredAt` T-120 s, T-90 s, T-10 s; cut T-60 s → first two, in that order).
  - `pending respects the limit` (25 old items in one shard; `limit` 7 → 7 items).
  - GSI reads are eventually consistent on AWS: integration assertions on the index poll for up to 5 s.
- [ ] **Step 1b: Unit test** `tests/unit/infra/outbox-store.test.ts`: `pending follows LastEvaluatedKey` with a fake `doc.send` returning two pages (3 + 2 items, the first with `LastEvaluatedKey`) → 5 items, second query carries `ExclusiveStartKey`; and stops at `limit` without asking for another page.
  - `clear removes the marker and stamps publishedAt` (item gone from `pending`, `publishedAt` set, `PK/SK` intact).
  - `clear ignores a missing item` (resolves, no item created).
- [ ] **Step 2: Run** `npx vitest run --project integration tests/integration/outbox-store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `outbox-store.ts`. The "missing item" case must not create an item (that is what the condition is for).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat: outbox store, pending query and marker clear`

### Task 4: The stream publisher clears the marker

**Files:**
- Modify: `src/events/publisher.ts` (`PublisherDeps`, `createPublisher`, `handler`)
- Test: `tests/unit/events/publisher.test.ts`

**Interfaces:**
- Consumes: `OutboxStore.clear` (Task 3), `BuiltEntry.key` (Task 1).
- Produces: `PublisherDeps` gains `clear: (key: OutboxKey) => Promise<void>` and `now: () => Date`; behavior otherwise unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `clears the marker of each accepted entry, after PutEvents`: two accepted entries → `clear` called with both keys, after `send` resolved.
  - `does not clear a rejected entry or anything after it` (first entry `ErrorCode` → no clear for it or later ones; same `batchItemFailures` as today).
  - `a failed clear is logged and the batch still succeeds` (`clear` rejects → result `{ batchItemFailures: [] }`, one log `{ level:'warn', msg:'outbox marker not cleared', correlationId }`).
- [ ] **Step 2: Run** `npx vitest run --project unit tests/unit/events/publisher.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Clear after each chunk's results are checked, accepted entries only, errors caught per entry. In `handler`, build the store from `createDocumentClient(createDynamoClient())` and `RIDECORE_TABLE`, `publishedAt = now().toISOString()`.
- [ ] **Step 4: Run** `make test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: stream publisher clears the outbox marker after PutEvents`

### Task 5: Reconciler core

**Files:**
- Create: `src/events/reconciler.ts`
- Test: `tests/unit/events/reconciler.test.ts`, `tests/integration/reconciler.test.ts`

**Interfaces:**
- Consumes: `buildEntry`, `chunkEntries` (Task 1); `OutboxStore` (Task 3); `OUTBOX_SHARDS` (Task 2).
- Produces: `type ReconcileSummary = { found: number; published: number; failed: number; oldestAgeSeconds: number }`;
  `createReconciler(deps: { store: Pick<OutboxStore,'pending'|'clear'>; send: PublisherDeps['send']; busName: string; log: Logger; now: () => Date; ageSeconds?: number /*60*/; maxPerRun?: number /*500*/ }): () => Promise<ReconcileSummary>`; lazy `handler` (bundled as `reconciler`).

- [ ] **Step 1: Write the failing unit tests** (fake store, fake send, fixed `now`):
  - `queries every shard with the cut now-60s` (10 `pending` calls, `before` = `now - 60 s` ISO).
  - `publishes in chunks of at most 10, never two of one trip in a call` (12 events, two of one trip).
  - `clears only accepted entries` (one `ErrorCode` → not cleared, counted in `failed`; others cleared).
  - `splits the cap fairly` (`maxPerRun` 500 → each shard asked with `limit` 50).
  - `rotates the starting shard` (`now` at minute 23 → first `pending` call is shard 3).
  - `a failing shard does not starve the others` (shard 0's `send` throws every run → shards 1-9 still published and cleared; shard 0 counted in `failed`; run resolves).
  - `logs one summary` `{ level:'info', msg:'outbox reconciled', found, published, failed, oldestAgeSeconds }`; `oldestAgeSeconds` = now − oldest `occurredAt`, 0 when nothing found.
  - `a failed clear does not count as failed publish` (logged, `published` still counts it).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `reconciler.ts`. Each shard is queried and published on its own; an error in one shard (query, send) is logged with the shard number, counted, and the run moves to the next shard.
- [ ] **Step 4: Integration test** `tests/integration/reconciler.test.ts`: `publishes an event the stream never delivered` — write an outbox item directly (`PutCommand` with `outboxPendingGsi2`, `occurredAt` 5 min ago), run `createReconciler` with the real store and a capturing `send` (bus delivery itself is proven by the demo in Task 7) → one entry with the golden-shaped `Detail`, marker cleared, `publishedAt` set; a second run finds 0.
- [ ] **Step 5: Run** `make test` and the integration file — Expected: PASS.
- [ ] **Step 6: Commit** `feat: outbox reconciler`

### Task 6: Deploy the reconciler on a schedule

**Files:**
- Modify: `scripts/build.ts` (entry `reconciler: 'src/events/reconciler.ts'`), `serverless.yml` (function `reconciler`)

- [ ] **Step 1:** Add the build entry and the function: `handler: dist/reconciler.handler`, `timeout: 60`, `events: - schedule: rate(1 minute)`. The shared role already allows Query, UpdateItem and PutEvents.
- [ ] **Step 2: Run** `make build && make package` — Expected: `dist/reconciler.mjs` exists; package succeeds.
- [ ] **Step 3: Verify on Floci** (the spec's platform risk; the spec asks for this first, it runs here because it needs the handler — ruling to ledger): `make up`, **disable the publisher's stream mapping** (so only the reconciler can clear), write one old pending item into the deployed table, wait 150 s, check marker gone and `publishedAt` set, re-enable the mapping. Expected: cleared.
  - If Floci does not invoke the scheduled Lambda: ledger a ruling and switch to the fallback from the spec — a CDK rule `rate(1 minute)` → a `ridecore-reconcile-ticks` SQS queue → the `reconciler` function with an `sqs` event (same handler, ignores the message body). Re-run this step.
- [ ] **Step 4: Run** `make e2e` — Expected: all existing flows PASS with the stream on.
- [ ] **Step 5: Commit** `feat: reconciler Lambda every minute`

### Task 7: Live demo `make outbox-demo`

**Files:**
- Create: `scripts/outbox-demo.ts`, `tests/unit/scripts/outbox-demo.test.ts`
- Modify: `Makefile` (target `outbox-demo`, same guard as `dlq-demo`), `README.md` (a section next to the DLQ demo)

**Interfaces:**
- Produces: `withStreamDisabled<T>(toggle: (enabled: boolean) => Promise<void>, fn: () => Promise<T>, signals: Pick<NodeJS.EventEmitter,'once'|'off'> = process): Promise<T>` — disables, runs `fn`, enables in `finally`; on SIGINT enables, then exits 130.

- [ ] **Step 1: Write the failing unit tests:** `re-enables after success`, `re-enables after fn throws` (error rethrown), toggle call order `[false, true]`, `re-enables on SIGINT` (fake emitter emits SIGINT while `fn` is pending → toggle `true` called; exit stubbed).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the script: find the publisher's mapping (`ListEventSourceMappings` for the deployed `publisher` function name), `withStreamDisabled` around: wait until the mapping state is `Disabled`; create the temporary SQS queue (with a resource policy allowing `events.amazonaws.com` to `sqs:SendMessage` from the rule) and a temporary rule for `detail-type: trip.requested` from `EVENT_SOURCE` **before** creating the trip (the API generates the id), then filter received messages by the new trip id; sign a passenger token with `RIDECORE_JWT_SECRET`, `POST /trips` with an `idempotency-key`; poll the queue printing `t=…s`; print `trip.requested published by the reconciler after N s`; delete rule and queue in `finally`. Timeout 4 min.
- [ ] **Step 4: Run** `make test` (unit PASS) and `make outbox-demo` on Floci — Expected: arrival between 60 and ~130 s; afterwards the mapping is `Enabled` (check with `aws lambda list-event-source-mappings` or the script's last line).
- [ ] **Step 5:** Paste a real run into the README section, like the DLQ demo.
- [ ] **Step 6: Commit** `feat: make outbox-demo`

### Task 8: ADR 0008 and trade-offs

**Files:**
- Modify: `docs/decisions/0008-scaling.md`

- [ ] **Step 1:** Add "Results: change 2 built (2026-11-13)": what was built, the demo timing measured in Task 7, the costs (one extra write per event; a `MODIFY` record on the stream per event; duplicates when the stream is slower than 60 s), why a sparse pending index instead of a scan for missing `publishedAt`, that only events written after the deploy are covered, that ~2 min is an objective, and the shard rule: changing `OUTBOX_SHARDS` needs a period reading both the old and new ranges (a hash bucket is not a physical partition; shared GSI2 throttling can back-pressure trip writes). State that the peak load rerun was not run unless Task 9 runs.
- [ ] **Step 2: Run** `npm run lint` and `make test` — Expected: PASS.
- [ ] **Step 3: Commit** `docs: ADR 0008, outbox reconciler results`

### Task 9 (optional): Peak load rerun

- [ ] Only if the owner asks: `make load PROFILE=peak`, record offered %, billed %, and the reconciler's `published` total next to the 2026-11-11 numbers in ADR 0008; commit `docs: peak load with the reconciler`.
