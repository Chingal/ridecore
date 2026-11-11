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

## Results (2026-11-11)

**Setup:**
- commit `6ad9861`, `floci/floci:2.4.0`, `grafana/k6:2.3.0`, Node.js 26.13.0;
- an Intel Core i5-1135G7 laptop with 8 threads and 15 GiB of RAM;
- one fresh `make up`, then `peak`, `spike` and `crowded` in a row.

Floci's CPU and memory were sampled every 10 s with `docker stats`.

| | `peak` | `spike` | `crowded` |
|---|---|---|---|
| Outcome | ran to the end; **checker: 54 violations** | **aborted** by the threshold (`http_req_failed` 5.15 % > 5 %) | ran to the end; checker violations were left over from `peak` |
| HTTP requests | 11,732 | 2,136 | none (watchers only) |
| HTTP latency p50 / p95 / p99 | 7 ms / 122 ms / 10 s (timeouts) | 10 ms / 10 s / 10 s | — |
| Failed requests | 1.13 % | 5.15 % | — |
| Offer push, `offeredAt` to the driver's socket, p50 / p95 | 1.0 s / 1.1 s | 1.1 s / 1.7 s | — |
| Request to `ACCEPTED`, p50 / p95 (2 s poll) | 21.7 s / 30.1 s | 18.9 s / 30.1 s | — |
| Trips completed / unaccepted after 60 s | 67 / 332 | 16 / 10 | — |
| 409s (by code) | 255 (226 `TRIP_ALREADY_TAKEN`, 19 `ACTIVE_TRIP_EXISTS`, 10 `INVALID_TRANSITION`) | 86 | 0 |
| Map messages received | 112,990 | 59,800 | 25,175 among 600 sockets |
| Sockets refused | 0 % | 0 % | 0 % |
| Floci CPU (max) / memory | 104 % / 316-359 MiB | 94 % / up to 448 MiB | 183 % / ~276 MiB |

From the table, for trips created during each run:

| | `peak` | `spike` |
|---|---|---|
| Trips created | 424 | 30 |
| Got at least one offer | 80 (19 %) | 6 (20 %) |
| Completed or rated | 57 | 4 |
| With a billing record | 12 (21 %) | 0 |

## What broke first, and why

**Events were lost between the table and EventBridge, not in ridecore's code.** Here is the evidence for one trip with no billing record (`2a291f40…`):
- Its `trip.completed` event is in the outbox (`EVENT#000005`).
- The API logged the request.
- The publisher never logged it, and billing never consumed it.
- The publisher-failures queue is empty, and the DLQs did not grow.

Floci's own log names the cause, on both stream mappings: `checkpoint … was trimmed, resuming from the trim horizon; records between were dropped from the stream`.

Floci keeps a bounded stream. Every driver position is a write to the driver item, so 100 drivers make about 33 writes per second. The publisher mapping reads at most 10 records per poll, about 30 polls a minute in the logs, and most of each batch is filtered out ("delivering 1 of 10 record(s) to ridecore-dev-publisher"). The publisher falls behind, Floci trims the records it has not read, and the trip events among them are gone. That explains both the trips without offers (`trip.requested` lost before dispatch) and the trips without billing (`trip.completed` lost).

**On AWS the same pressure is lag, not loss.** A DynamoDB stream keeps records for 24 hours, so the publisher would not lose them. It would fall minutes behind instead (`IteratorAge`), and offers and fares would arrive minutes late. Either way, trip events wait behind position traffic because they share one stream. ADR 0008 takes this up.

**The crowded cell never reached the 500-watcher cap.** The positions mapping hit the same stream bottleneck first. It got 55 batches in about 2.3 minutes, with trims, so most positions were never processed. Connection and watch items, which are also table writes, add to the stream too. The cap path (`ConnectionRepo.watchersOf` throws past 500) is still untested under load.

**What held:**
- No socket was refused.
- The 409s are the races working as designed: 226 of the 255 are drivers losing an accept race.
- The checker found no reservation, outbox-gap or stuck-driver violation. Under this load the transactions kept every trip consistent; what was lost was delivery.
