# Outbox reconciler — design

Date: 2026-11-12. Implements change 2 of ADR 0008 (`docs/decisions/0008-scaling.md`).

## Why

Every trip transition writes the trip and its event in one transaction (the outbox, ADR 0004). The
only path from the outbox to EventBridge is the table stream → `publisher` Lambda. If a stream record
is dropped or delayed, the event is never published and nothing notices: the trip is never offered,
or it finishes without a billing record.

The 2026-11-11 peak run measured exactly that: 43 % of trips got an offer and 47 % of finished trips
were billed, with Floci logging hundreds of "checkpoint was trimmed" warnings. On AWS the same
pressure would show as stream delay, not loss, but the design should not depend on that.

The goal: **no trip event stays unpublished for more than about two minutes, on any platform.**
Consumers already tolerate duplicates (ADR 0004: billing and driver-offers keep `CONSUMED#` records,
dispatch offers once per trip, ridecore-location is version-aware), so the fix may publish an event
twice but never zero times.

## Goals

1. Every outbox event carries a "pending" marker from the moment it is written until it is on the bus.
2. The stream publisher clears the marker after a successful PutEvents.
3. A scheduled reconciler runs every minute, finds pending events older than a threshold, publishes
   them and clears the marker.
4. A test proves recovery with the stream path switched off.
5. **A live demo** (`make outbox-demo`): with the stream publisher disabled, create a trip and watch
   `trip.requested` reach the bus about a minute later through the reconciler, then re-enable the stream.
   The owner asked for this explicitly, for interviews.
6. Optional (owner, 2026-11-13): a peak load rerun, compared with the 2026-11-11 numbers, recorded in ADR 0008 "Results".
7. ADR 0008 updated (change 2 done, with what was measured); a learning note on the trade-offs.

## Non-goals

- Exactly-once delivery. At-least-once plus idempotent consumers is the contract; no 2PC.
- Replacing the stream path. The stream stays the fast path; the reconciler is the safety net.
- Change 1 (publisher batch size) and the other ADR 0008 changes.
- Strict per-trip ordering on the recovery path (see "Ordering" below).

## Anti-goals (would be a failure even if it "works")

- A recovery path that can publish an event **zero** times (e.g. clearing the marker before PutEvents succeeds).
- A sweep that scans the whole table.
- A pending index that becomes a hot partition at scale with no way out.
- Any change in behavior when the stream works: same events, same order, same consumers.

## The design

### The pending marker (my call: reuse GSI2, sharded)

The outbox item gets sparse GSI2 keys when written, in the same transaction as today:

- `GSI2PK = OUTBOX#<shard>` where `shard` = a stable hash of `tripId` mod `OUTBOX_SHARDS` (10).
- `GSI2SK = <occurredAt>#<tripId>#<version padded 6>`.

GSI2 is already shared by prefixes (`AVAIL#<cell>`, watch cells), so this needs no table change and no
Floci table recreation. Sharding by trip keeps one trip's events in one shard (sorted by time) and
spreads write load over 10 partitions; the sweep queries the 10 shards. Clearing the marker is an
`UpdateItem REMOVE GSI2PK, GSI2SK` with `ConditionExpression: attribute_exists(PK)`; a missing item is
ignored.

The ADR's wording was "stamp `publishedAt`". A sparse "pending" index is the same idea turned around:
the sweep reads only what is still pending instead of filtering everything by a missing attribute.
The item also gets `publishedAt` when the marker is cleared, for debugging.

GSI2 projects the whole item (`ProjectionType.ALL`, `infra/cdk/stateful-stack.ts`), so the sweep needs
no second read. Outbox items have no `expiresAt`, so a pending item is never purged by TTL.

**The event body must not change.** Today the publisher builds `Detail` from every item attribute
except `PK`, `SK` and `entity`. The new `GSI2PK`, `GSI2SK` and `publishedAt` must be stripped too, by
one entry builder shared by the stream publisher and the reconciler. A golden test pins the `Detail`
of a stream-published event to exactly what it is today.

### Stream publisher change

After a chunk's PutEvents result says an entry was accepted, the publisher clears that event's marker.
If clearing fails, it logs and moves on: the reconciler will publish the event again later, which is
a harmless duplicate. Clearing never blocks or fails the stream batch.

The clear writes a `MODIFY` record to the stream. The stream filter already passes only `INSERT`s of
`entity = EVENT`, so the publisher is not invoked for it, but it is extra stream traffic. This is the
main cost of the design (one extra write per event) and goes into the learning note.

### The reconciler

- A new Lambda `reconciler` (`src/events/reconciler.ts`), bundled like the others, triggered every
  minute by a schedule in `serverless.yml`.
- For each shard: `Query GSI2 where GSI2PK = OUTBOX#n and GSI2SK < <now - 60 s>`, oldest first,
  paginated, capped per run (e.g. 500 events in total) so one run stays well inside the Lambda timeout.
- Publishes with the existing `chunkEntries` rules (≤10 per call, never two events of one trip in a
  call), then clears the marker of each accepted entry. Rejected entries keep the marker and are retried
  next minute.
- Logs a summary per run: `{ msg: 'outbox reconciled', found, published, failed, oldestAgeSeconds }`.
  `oldestAgeSeconds` is the metric that matters: it is the bound the design promises.

The sweep orders by `occurredAt` (the domain time of the transition), not the write time. If an event
is written with an older `occurredAt` (a retry, clock skew), it may be swept before its stream record
arrives: a harmless extra duplicate. The same happens on AWS when the stream is slow but not lost
(iterator age above 60 s): the event is published twice. Both are accepted; no "claim" step.

Thresholds: age 60 s, schedule 1 min → an event lost by the stream is on the bus within about 2 min.

### Ordering

The stream publishes a trip's events in order. The reconciler publishes pending events per shard in
`occurredAt` order, so one trip's pending events go out in order, but a recovered `trip.requested`
can arrive after later events that went through the stream. Consumers were built for at-least-once
delivery; the builder must check each consumer (dispatch, billing, driver-offers, notifications,
ridecore-location) for what an out-of-order or late event does, and record the result. A consumer
that mis-handles it is a finding to fix in this work, not a reason to drop the reconciler.

### Platform risk

The 2026-11-12 spike showed Floci firing an EventBridge `rate(1 minute)` rule to an SQS target, 60 s
apart. A rule invoking a **Lambda directly** was not verified. First task: verify it with the osls
`schedule` event. Fallback: rule → SQS queue → reconciler Lambda (same code, SQS trigger).

### Live demo: `make outbox-demo`

Mirrors `make dlq-demo`. Requires `make up`.

1. Disable the publisher's stream event source mapping (`UpdateEventSourceMapping Enabled=false`).
2. Create a trip through the API, print its id and the time.
3. Watch for `trip.requested` of that trip on the bus (through a temporary rule → SQS queue the script
   creates and deletes), printing elapsed seconds; show the reconciler's log line if available.
4. Re-enable the mapping and clean up, **also on Ctrl-C or error** (a demo must never leave the stream off).
5. Print the result: "trip.requested published by the reconciler after N s".

Expected output: the event arrives between 60 and ~130 s.

### Tests

- Unit: shard function (stable, in range); reconciler with fakes (only events older than the threshold,
  chunking, marker cleared only for accepted entries, cap respected, summary log); publisher clears the
  marker only after acceptance and survives a failed clear.
- Integration (Floci): a written event appears in the pending index; publishing clears it; the
  reconciler publishes an event whose stream record never reached the publisher (write the item
  directly, invoke the reconciler handler).
- e2e: the existing flows still pass with the stream on.
- Load: the reconciler's `published` total per run is reported with the results (it counts events
  recovered plus duplicates of slow stream records). `make load PROFILE=peak` (both paths if time allows), compared with 2026-11-11. Target: ~100 %
  of finished trips billed, no event pending more than ~2 min. If the target is not met, record what
  was measured, as ADR 0008 already does.

## Constraints

- Node 26, TypeScript, existing patterns (`createX(deps)` + lazy `handler`, `jsonLog`).
- Docs in `docs/design/` and `docs/plans/`; no tool names in paths.
- Commits without `Co-Authored-By`; no push without the owner's order. Public repo: no client or
  employer names.

## Left to the builder

File layout inside `src/events/`, exact log fields, the per-run cap value, how the demo watches the bus,
and whether the shard hash is FNV or a slice of a SHA-1.

## Calls I made (not the owner's)

- Reuse GSI2 with an `OUTBOX#<shard>` prefix instead of a new index.
- 10 shards, 60 s age threshold, 1-minute schedule.
- Clear failures are logged and ignored (duplicate later beats a failed stream batch).
- Add `publishedAt` on clear, for debugging.
- One entry builder for both paths, stripping the index and debug attributes, pinned by a golden test.
- Duplicates from slow stream records are accepted; the load report shows the reconciler's total.
