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
