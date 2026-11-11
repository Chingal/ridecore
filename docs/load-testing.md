# Load testing (local)

Floci on a laptop: these numbers show behaviour under concurrency, not AWS capacity.

## k6 spike

On 2026-11-11, k6 2.3.0 (`grafana/k6:2.3.0`, run with `docker run --network host`) was checked against Floci 2.4.0 with the stack from `make up`:

| Check | Result |
|---|---|
| (a) HTTP call with a bearer token to `RIDECORE_API_URL` | **Pass**: 200 |
| (b) `k6/websockets` opens `RIDECORE_WS_URL` with the subprotocols `['ridecore.v1', <token>]` | **Pass**: open, `protocol = ridecore.v1` |
| (c) a `watch` message gets `car` messages back | **Pass**: 6 cars in 5 s, the seeded ones |
| (d) `*.execute-api.localhost.floci.io` resolves inside the container | **Pass**, since (b) connected through it |

**Consequence:** k6 drives both the HTTP and the WebSocket traffic. No Node fallback client is needed.

## How to run

```bash
make up                      # the stack in Floci
make load PROFILE=smoke      # smoke | peak | spike | crowded
make load-teardown           # only after an interrupted run
```

`make load` takes these steps:
1. Creates the load actors in their own area, east of Popayán (`scripts/load/actors.ts`).
2. Records the DLQ depths.
3. Runs k6 (`load/rush-hour.js`).
4. Runs the invariant checker (`scripts/load/check.ts`).
5. Tears down, always, even when a step failed.

The k6 summary is saved as `.load/summary-<profile>-<time>.json`, which is git-ignored.

**What the checker covers:**
- It checks only the trips created since the run started (`.load/baseline.json`), so an earlier bad run does not fail later ones.
- It fails if it read no trips, no drivers or fewer than the 8 queues.
- It also runs after k6 aborted, when Floci still answers.
- "Queues drained" means the SQS queues are empty. Records still waiting in the table stream are not visible to it, so a lagging publisher shows up as missing billing.
- Teardown runs after a failed step and after Ctrl-C.


| Profile | Drivers | Passengers | What it models |
|---|---|---|---|
| `smoke` | 5 | 10 | does everything start and finish (45 s) |
| `peak` | 100 | 200 (100 watching the map, 100 riding) | a rush hour, ramping up over 2 min, held for 3 min |
| `spike` | 100 | 200 | a quiet minute, then most riders arriving within 20 s |
| `crowded` | 20 | 600 watching one cell | a crowded map cell, past the 500-watcher query cap |

**Actors:**
- **Drivers** send a position every 3 s over WebSocket and accept offers. After accepting, they arrive, start and complete the trip.
- **Watchers** keep the map open.
- **Riders** request a trip and wait up to 60 s for a driver. 20 % of them cancel; the rest ride and rate.

**The checker** reads every load actor's trips and checks:
1. reservations and active trips agree;
2. every finished trip has a billing record;
3. no driver is stuck `ON_TRIP`;
4. each trip's outbox events go 1..N;
5. queues drain and DLQs do not grow.

## The Go path (ridecore-location)

The same profiles can run with driver positions and the live map in
[ridecore-location](https://github.com/Chingal/ridecore-location), a Go service next to this repository
(`LOCATION_DIR`, default `../ridecore-location`):

```bash
make up LOCATION=1                 # also Redis, Kafka and the Go service; the Lambdas get the switch on
make load PROFILE=peak LOCATION=1  # same profiles, same checker
make down                          # also stops the Go service
```

- `make up LOCATION=1` adds the location variables to `.env.local` when they are missing (dev-only
  values; yours are never overwritten), deploys as usual, then starts the service. Its log is
  `.load/location.log`, with a `stats` line every 10 s (map messages sent and dropped, Kafka errors).
- With `RIDECORE_LOCATION_URL` set, dispatch asks the service for the nearest 50 fresh drivers and
  keeps those still `AVAILABLE` in DynamoDB (`src/infra/location/client.ts`).
- `make load LOCATION=1` stops before creating actors if the service does not answer `/healthz`.
- On this path drivers open two sockets: ridecore's, for offers and trip events only, and
  ridecore-location's, for positions. Load drivers are created without a position in DynamoDB, so
  they never enter the availability index. Watchers use the service's map socket. There
  `map_messages` counts `cars` messages, one per watched cell per second, while ridecore's map sends
  one message per car change. The two numbers are not comparable.
- Trip assignments reach the service through the `ridecore-location-trips` queue (an EventBridge rule
  for `trip.accepted`, `trip.completed` and `trip.cancelled`). The checker does not read that queue's
  DLQ yet.

## Results (2026-11-11)

**Setup:**
- commit `6ad9861`, `floci/floci:2.4.0`, `grafana/k6:2.3.0`, Node.js 26.13.0;
- an Intel Core i5-1135G7 laptop with 8 threads and 15 GiB of RAM;
- one fresh `make up`, then `peak`, `spike` and `crowded` in a row.

Floci's CPU and memory were sampled every 10 s with `docker stats`.

| | `peak` | `spike` | `crowded` |
|---|---|---|---|
| Outcome | ran to the end; **checker: 54 violations**, all "RATED but has no billing record" | **aborted** by the threshold (`http_req_failed` 5.15 % > 5 %); the checker did not run then (fixed since) | ran to the end; its 71 violations were trips of `peak` and `spike` (the checker then read every past trip; fixed since) |
| HTTP requests | 11,732 | 2,136 | none (watchers only) |
| HTTP latency p50 / p95 / p99 | 7 ms / 122 ms / 10 s (timeouts) | 10 ms / 10 s / 10 s | — |
| Failed requests | 1.13 % | 5.15 % | — |
| Offer push, `offeredAt` to the driver's socket, p50 / p95 | 1.0 s / 1.1 s | 1.1 s / 1.7 s | — |
| Request to `ACCEPTED`, p50 / p95 (polled every 2 s, so a lower bound of 2 s) | 21.7 s / 30.1 s | 18.9 s / 30.1 s | — |
| Trips completed / unaccepted after 60 s | 67 / 332 | 16 / 10 | — |
| 409s (by code) | 255 (226 `TRIP_ALREADY_TAKEN`, 19 `ACTIVE_TRIP_EXISTS`, 10 `INVALID_TRANSITION`) | 86 | 0 |
| Map messages received | 112,990 | 59,800 | 25,175 among 600 sockets |
| Sockets refused | 0 % | 0 % | 0 % |
| Floci CPU (max) / memory (min-max) | 104 % / 244-445 MiB | 94 % / 163-448 MiB | 183 % / 234-328 MiB |

From the table, for the trips created during each run. The run windows come from the k6 summaries, and the output is in [`docs/load-results/2026-11-11/ratios.txt`](load-results/2026-11-11/ratios.txt):

| | `peak` (17:19:14-17:25:24 UTC) | `spike` (17:25:29-17:27:26) |
|---|---|---|
| Trips created | 419 | 116 |
| Got at least one offer | 98 (23 %) | 22 (19 %) |
| Completed or rated | 69 | 18 |
| With a billing record | 15 (22 %) | 1 (6 %) |

The counts come from `node --import ./scripts/load-env.ts scripts/load/ratios.ts <from> <to>`.

## What broke first, and why

**Trip events were dropped from the table stream before the publisher read them.** Evidence for one trip with no billing record (`2a291f40…`):
- Its `trip.completed` event is in the outbox (`EVENT#000005`), and the API logged the request.
- The publisher never logged it, and billing never consumed it.
- The publisher-failures queue is empty, and the DLQs did not grow.
- Four minutes later it was still unbilled, so this is loss, not lag.

Floci's own log names the cause. From 17:20:07 to 17:29:36 it logged, about once a second, `checkpoint … was trimmed, resuming from the trim horizon; records between were dropped from the stream`. There were 426 such lines for the publisher's mapping and 408 for the positions mapping ([`floci-streams.txt`](load-results/2026-11-11/floci-streams.txt)).

**How it happens:**
- Every driver position is a write to the driver item, so 100 drivers make about 33 stream records per second.
- The publisher's mapping gets 16 to 43 batches a minute.
- Almost every batch is "1 of 10 record(s)" after the filter: the other nine are positions it has to read past.
- Floci keeps a bounded stream and trims what the mappings have not read yet.

That explains the trips without billing. The trips without an offer are most likely the same thing, `trip.requested` dropped before dispatch, but that part is inferred: it was not traced one by one.

**What this means for AWS is a hypothesis, not a measurement.** A DynamoDB stream on AWS keeps records for 24 hours. With the same traffic the expected symptom is lag (`IteratorAge`), not loss. How much lag depends on AWS throughput, and the laptop cannot measure that. The design point holds either way: trip events share one stream with position traffic. ADR 0008 takes this up.

**The crowded cell never reached the 500-watcher cap.** The positions mapping hit the same trimming first: between 15 and 44 batches a minute during that run. Connection and watch items, which are table writes too, added to the stream. The cap path (`ConnectionRepo.watchersOf` throws past 500) is still untested under load.

**What held:**
- No socket was refused.
- The 409s are the races working as designed: 226 of the 255 are drivers losing an accept race.
- After `peak`, the checker found no reservation, outbox-gap or stuck-driver violation, only missing billing. The transactions kept every trip consistent; what was lost was delivery.
