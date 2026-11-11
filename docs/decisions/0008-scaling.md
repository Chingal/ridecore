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
