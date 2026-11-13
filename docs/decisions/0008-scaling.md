# ADR 0008: Scaling: what breaks first, and what to change

Date: 2026-11-11. Status: accepted, as the analysis behind the changes below. None of the changes is built yet.

## Context

The design spec leaves high-scale load testing out of scope (§3). Plan 5 still ran a rush hour against the local stack (`docs/load-testing.md`): 100 drivers sending a position every 3 s, 200 passengers watching the map and requesting trips, a spike, and a crowded map cell. Floci on a laptop does not measure AWS capacity, but it does show where the design is weak under concurrency. This ADR records what broke, what the code says will break next, and what to change, cheapest first.

## Findings

**1. Trip events share the table stream with driver positions.** This was measured on Floci.
- Every position is a write to the driver item, so it is also a stream record.
- The publisher's mapping filters those out, but it still has to read them: almost every batch carries 1 useful record out of 10.
- At 100 drivers, about 33 position writes per second, Floci's bounded stream trimmed records the publisher had not read yet. It logged this about once a second.
- Result in `peak`: only 23 % of trips got an offer, and 22 % of finished trips got billed. The trips themselves stayed consistent. One unbilled trip was traced end to end. That the missing offers had the same cause is inferred.
- On AWS the stream keeps records for 24 hours, so the expected symptom is lag (`IteratorAge`) rather than loss. That is a hypothesis this laptop cannot measure. Either way, delivery of trip events depends on position traffic.

**2. The map fan-out grows as drivers × watchers.** This comes from the code.
- One position triggers a query of 9 cells for watchers, then one `PostToConnection` per watcher.
- `crowded` (600 watchers in one cell) hit finding 1 before reaching this.
- The cap `ConnectionRepo.watchersOf` throws past 500 watchers. It then retries 3 times and drops the record, so a crowded cell loses its map updates.

**3. Hot partitions per geohash-5 cell.** This comes from the code. `AVAIL#<cell>` and `WATCH#<cell>` are each one partition key, and a cell is about 5 km wide. A rush hour downtown puts most writes on a few keys. A DynamoDB partition takes about 1,000 writes per second.

**4. One concurrency pool for every function.** This comes from the code and the account defaults. Lambda concurrency is shared per region (1,000 by default), and every WebSocket message is one invocation. Map traffic can therefore starve the trip API and dispatch.

**5. No re-offer.** This comes from the code. An unaccepted trip waits until the passenger cancels. In `peak`, 332 riders gave up after 60 s. Many of those trips probably lost their `trip.requested` event (finding 1, inferred), but under real demand the same happens whenever the five nearest drivers decline or are busy.

## Decision: changes, cheapest first

| # | Change | Fixes | Cost |
|---|---|---|---|
| 1 | **Raise the publisher mapping's batch size** (10 today) and add a parallelization factor; alarm on `IteratorAge` | finding 1, partly | config |
| 2 | **Outbox reconciler.** Stamp each event `publishedAt` once it is put on the bus, and run a scheduled sweep that republishes events older than N seconds without it. Consumers already deduplicate (ADR 0004). | finding 1 on any platform: no event stays unpublished | small |
| 3 | **Reserved concurrency** for the API, dispatch and billing | finding 4: the map degrades first, trips never | config |
| 4 | **Per-user limits:** sockets per passenger, `watch` rate, and a maximum distance from the passenger's own position | finding 2, and the map privacy risk in ADR 0005 | small |
| 5 | **One map message per cell every 1-2 s** instead of one per car, and skip positions of cars that have not moved | finding 2: pushes become cells × watchers per second | medium |
| 6 | **Positions out of the trip table:** a separate table, Kinesis, or a geo index in Redis (ElastiCache) | findings 1 and 3: the outbox stream carries only trip events | large |
| 7 | **Managed fan-out by topic** (IoT Core MQTT or AppSync Events, one topic per cell) instead of `PostToConnection` per socket | finding 2 at large scale | large |
| 8 | **Re-offer with a growing radius**; at peak, **match in batches** every 2-5 s | finding 5 | medium |
| 9 | Finer cells (precision 6) where traffic is dense | finding 3 | medium |

Changes 1 to 3 come first: they are cheap, and they turn the worst failure (events lost or delayed behind positions) into a visible, bounded delay. Changes 6 and 7 are what a production ride-hailing backend ends up with. They are not needed to show the design.

## Consequences

- `make load` and its invariant checker stay in the repo. Rerun them after each change above: `peak` should show offers and billing for every trip once change 1 or 2 is in.
- Nothing here was measured on AWS. A real-AWS test needs a staging account, a cost estimate and the owner's approval. It would add the numbers this laptop cannot give: real latency, `IteratorAge`, throttling and cost per trip.

## Results: change 6 built (2026-11-11)

Change 6 is [ridecore-location](https://github.com/Chingal/ridecore-location), a Go service with
positions in Redis and Kafka, behind the `RIDECORE_LOCATION_URL` switch (docs/load-testing.md, "The
Go path"). Both runs below used the same laptop and the same Floci, minutes apart, with the Go stack
running in both (idle in "before"). Profile `peak`: 100 drivers, 200 passengers.
Raw numbers: `docs/load-results/2026-11-11-location/`.

| `peak` | Before (switch off) | After (Go path) |
|---|---|---|
| Trips created | 432 | 416 |
| Got an offer | 124 (29 %) | **177 (43 %)** |
| Finished | 85 | **130** |
| Finished with a billing record | 19 (22 %) | **61 (47 %)** |
| Invariant violations (all "finished, no billing record") | 67 | 73 |
| Floci "checkpoint was trimmed" warnings | 524 | 457 |
| HTTP requests failed | 0 % | 1.88 % (p99 10 s) |

**What it shows:**
- Taking positions out of the trip table roughly doubles the trips that finish and the share that are
  billed, and raises offers from 29 % to 43 %. Finding 1's cause was real.
- It does **not** reach the target of every trip offered and billed. Floci still trims the table
  stream, now with trip traffic alone. On this emulator the outbox stream, not positions, is the
  bottleneck. The violation count barely moves because far more trips finish, and the same bottleneck
  then leaves more of them unbilled.
- The 1.88 % failed requests in the after run are not explained. The 10 s ceiling is the Lambda
  timeout. The working guess is Floci saturating under more trips in progress (arrive, start,
  complete, rate). It is a guess, not a measurement.

**What it means for the order of changes:**
- Changes 1 and 2 (publisher batch size, outbox reconciler) are now the next step. Change 2 in
  particular makes a lost or late `trip.requested` or `trip.completed` recoverable on any platform,
  which is exactly what is still failing.
- On AWS the hypothesis stays the same: DynamoDB Streams keeps records for 24 h, so the same pressure
  would show as `IteratorAge` and delay, not loss. This laptop cannot confirm it.

**Limits of this comparison:**
- On the Go path a load driver becomes a candidate at its first position, during the ramp. On the
  DynamoDB path it is one from setup on.
- `map_messages` counts different things on each path (cars vs one message per cell per second).
- The runs were made at ridecore `3c538c8` and ridecore-location `ded4c95`. The fixes that came after
  them (a Codex review: one switch, the checker reading the location queue, how trip events are
  retried) do not change the measured paths.

## Results: change 2 built (2026-11-13)

Change 2 is the outbox reconciler. Design: `docs/design/2026-11-12-outbox-reconciler-design.md`.

**What was built**
- Every outbox item is written with a sparse "pending" marker on GSI2 (`OUTBOX#<shard>`, 10 shards by a
  hash of the trip id, sorted by `occurredAt`), in the same transaction as the trip.
- The stream publisher clears the marker after EventBridge accepts the event and stamps `publishedAt`. A
  failed clear is logged and never fails the batch.
- A `reconciler` Lambda runs every minute. It reads each shard for events pending more than 60 s, at most
  50 per shard (500 per run), starting at a different shard every minute. It publishes them with the
  publisher's chunking rules, clears the accepted ones, and moves a rejected one to the back of its shard,
  so a stuck event never fills its shard's budget. A shard that fails is logged and the run moves on.
- One entry builder serves both paths. A golden test pins the event body to what the publisher sent
  before this change.

**What was measured (Floci, laptop)**
- The schedule fires the Lambda directly on Floci: with the publisher's stream mapping disabled, an
  event written 5 minutes earlier was published and cleared 45 s after it was written.
- `make outbox-demo` (stream to the publisher off, then a new trip): `trip.requested` reached the bus
  through the reconciler after 92 s. The expected window is 60 to about 130 s.
- Peak load rerun, Go path, same laptop and Floci as 2026-11-11 (raw numbers:
  `docs/load-results/2026-11-13-reconciler/`):

| `peak`, Go path | 2026-11-11 (no reconciler) | 2026-11-13 (reconciler) |
|---|---|---|
| Trips created | 416 | 411 |
| Got an offer | 177 (43 %) | 171 (42 %) |
| Finished | 130 | 122 |
| Finished with a billing record | 61 (47 %) | **121 (99 %)** |
| Invariant violations at the end of the run | 73 | 3 (all "billed late") |
| Violations about 3 minutes later | (still unbilled) | **0** |
| Floci "checkpoint was trimmed" warnings | 457 | 463 |
| HTTP requests failed | 1.88 % | 1.11 % |
| Events published by the reconciler | - | 761, none failed |
| Oldest pending event seen | - | 120 s |

  **What it shows:** Floci trims the stream as much as before, but no event is lost any more. The
  reconciler published 761 events the stream dropped or delayed, and none waited more than 120 s.
  Billing went from 47 % to 99 % at the end of the run and to 100 % three minutes later.

  **What it does not fix:** offers stayed at 42 %. A recovered `trip.requested` arrives up to two
  minutes late, after many load passengers have given up, and 100 drivers serve more than 400 trips.
  Recovering an event is enough for billing, which can wait. It is not enough for an offer, which
  cannot. That makes change 1 (publisher batch size: less stream lag) the next step for offers.

**Consumers and late or duplicate events.** The reconciler may publish an event twice, or after later
events of the same trip. Each consumer was checked:

| Consumer | Duplicate | Late |
|---|---|---|
| dispatch (`trip.requested`) | republishes the recorded offers; driver-offers dedups by `offerId` | no offers once the trip left `REQUESTED` (`src/app/dispatch.ts:122`) |
| billing (`trip.completed`) | one record per trip (`duplicate billing event`) | nothing comes after `trip.completed` |
| driver-offers (offers) | acked by `offerId` | dispatch emits no offer for a trip that left `REQUESTED` |
| notifier (every `trip.*`) | pushed again; clients keep the newest `version` | same: clients drop anything not newer |
| ridecore-location (accepted, completed, cancelled) | a version already applied is ignored | same (`internal/store/store.go:149`) |

No consumer needed a fix.

**Trade-offs and limits**
- Cost: one extra write per event (the clear), which also puts a `MODIFY` record on the table stream.
  The stream filter passes only `INSERT`s of events, so the publisher is not invoked for it.
- Duplicates: when the stream is slower than 60 s (on AWS, `IteratorAge` above a minute), the event is
  published by both paths. Accepted, because every consumer above absorbs it.
- A sparse pending index instead of scanning for a missing `publishedAt`: the sweep reads only what is
  still pending, and its cost does not grow with the size of the table.
- Scope: only events written after this deploys carry the marker. Events lost before it are not
  recovered.
- "About two minutes" is an objective, not a guarantee. The cap per run, retries, the eventual
  consistency of the index and schedule delays can stretch it. `oldestAgeSeconds` in the reconciler's
  log is the number to watch.
- Shards: 10 hash buckets spread the writes, but they are not 10 physical partitions. Changing
  `OUTBOX_SHARDS` needs a period that reads both the old and the new range, or markers are stranded. The
  pending index shares GSI2 with driver availability and map watches, so heavy throttling on GSI2 would
  push back on trip writes.
