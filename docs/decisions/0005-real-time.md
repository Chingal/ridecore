# ADR 0005: Real-time updates over WebSocket

Date: 2026-11-11. Status: accepted.

## Floci spike

Before building the real-time layer (Plan 2b) we checked each piece on Floci 2.4.0 (`ridecore-floci-1`, port 4567). We used a throwaway osls service with one Node 24 Lambda on `$connect`, `$disconnect` and `$default`, AWS CLI 1.46.3 in a throwaway venv, dummy credentials, and Node 26's global `WebSocket` as the client. All spike resources were removed afterwards.

| Check | Result | Evidence |
|---|---|---|
| (a) osls `websocket` events deploy; client URL | **Pass**, subdomain URL only | `Service deployed to stack spkws-dev`. `ws://<apiId>.execute-api.localhost.floci.io:4567/<stage>` opens and runs `$connect`; `localhost.floci.io` and its subdomains resolve to loopback through public DNS. The path form `ws://localhost:4567/_aws/execute-api/<apiId>/<stage>` is **not** upgraded: Floci serves it as plain HTTP and invokes `$default` with no `connectionId` |
| (b) What `$connect` receives; token transport | **Pass**, both ways | `headers['sec-websocket-protocol']` = `"ridecore.v1, tok.en-123_abc"`. Returning `Sec-WebSocket-Protocol: ridecore.v1` keeps the socket open (`ws.protocol === 'ridecore.v1'`). `queryStringParameters` carries `?token=…` (plus `stage`). Returning `statusCode: 401` makes the client's open fail |
| (c) `PostToConnection` from a Lambda | **Pass** with the subdomain endpoint | Inside the Lambda `AWS_ENDPOINT_URL` is `http://localhost.floci.io:4566`. Endpoint `http://<apiId>.execute-api.localhost.floci.io:4566/<stage>` → the client received `subEp:hello`. On AWS the form is `https://<apiId>.execute-api.<region>.amazonaws.com/<stage>`. Two other endpoints fail: `AWS_ENDPOINT_URL` itself → `UnknownOperationException` 404; the path form `…/_aws/execute-api/<apiId>/<stage>` → "ok", but nothing is delivered and Floci invokes `$default` with the posted body |
| (d) Post to a closed or unknown connection | **Pass** | `GoneException` 410 |
| (e) `$default` receives the client's message | **Pass** | `body: "hello"`, with `connectionId` |
| (f) A second stream mapping with its own filter | **Pass** | Two functions on one stream, with filters `entity: EVENT` (INSERT) and `entity: DRIVER` (INSERT, MODIFY). After writing an EVENT item, a DRIVER item, a TRIP item, then modifying the DRIVER and EVENT items: the first saw `[INSERT e2]`, the second `[INSERT d2, MODIFY d2]`, and the TRIP item reached neither. Records written while a new `LATEST` mapping was still starting were skipped, and one batch arrived twice |
| (g) Node 26 `WebSocket` as the test client | **Pass** | Rows (a), (b) and (c) ran with it |
| (h) The WebSocket API id inside the functions | **Pass** | `environment: WS_API_ID: !Ref WebsocketsApi` resolved to the deployed id (`deb1eebd4a`) in every invocation |

**Consequences:**
- **No fallback needed.** The local `ws` adapter of spec §5b is not built. The WebSocket API runs on Floci like it does on AWS.
- **Token transport: subprotocol.** The client offers `["ridecore.v1", <jwt>]` and `$connect` answers `Sec-WebSocket-Protocol: ridecore.v1`. Browsers cannot send an `Authorization` header on a WebSocket. A query-string token would end up in URLs and access logs, so we don't use it.
- **Management endpoint.** The functions get `RIDECORE_WS_API_ID` (`!Ref WebsocketsApi`) and `RIDECORE_WS_STAGE` (`${sls:stage}`) and build the endpoint in one function:
  - when `AWS_ENDPOINT_URL` is set (Floci): `<scheme>://<apiId>.execute-api.<that host>/<stage>`;
  - otherwise (AWS): `https://<apiId>.execute-api.<region>.amazonaws.com/<stage>`.
- **`$default` without a `connectionId` is ignored.** On Floci that is an HTTP request, not a socket message. During the spike, a handler that pushed on every `$default` triggered itself through the path-form endpoint and ran in a loop until we removed it.
- **Start the positions mapping before seeding.** Each mapping keeps its own filter. A `LATEST` mapping skips records written while it starts, so `make up` seeds after deploying.

## Context

The trip API and the event path (ADR 0004) change state and deliver events, but a passenger only learns that a driver accepted by asking again. The design (spec §5b) asks for pushes: trip updates to each trip's passenger and driver, offers to drivers, and nearby cars on the passenger's map. A long-lived socket server does not fit Lambda, so the sockets live in API Gateway and Lambdas push to them.

## Decision

**Who owns what.** The WebSocket API and its three routes (`$connect`, `$disconnect`, `$default`) belong to osls: they are function triggers, like the HTTP API. Connections are items in the CDK table (`CONN#<id>`, TTL = 2 h 10 min, because API Gateway closes a socket after 2 h). The notifications queue and its rule are CDK resources, like every other queue. Nothing in the real-time layer writes trip state.

**Connect.** The client offers the subprotocol `ridecore.v1` followed by its dev JWT, the same token as the HTTP API. `$connect` verifies the token and stores the connection with the actor (passenger or driver), or answers 401. The token is never logged.

**Three delivery patterns:**

| Pattern | Trigger | Recipients |
|---|---|---|
| Trip updates | every `trip.*` event: an EventBridge rule on the source feeds `ridecore-notifications`, consumed by the notifier | the trip's passenger, and its driver once there is one (from the event payload) |
| Offers | the driver-offers consumer (ADR 0004), on the first delivery of an `offerId` | that driver |
| Map | a second stream mapping on the table, filtered to driver items | `car` and `car.left` go to passengers watching the driver's geohash-5 cell or its 8 neighbours. An on-trip driver's position (`driver_position`) goes only to that trip's passenger |

**Routing by actor, not by trip.** Each connection item records who is connected, not which trip it follows. Every event payload already names its passenger and driver, so nothing has to update connection items when a trip changes. The cost is one index query per recipient (GSI1, `CONNACTOR#<role>#<id>`). Passengers watching a cell are found the same way (GSI2, `WATCH#<cell>`, next to the existing `AVAIL#<cell>` keys).

**Duplicates and order are the client's job.** Pushes are at-least-once and SQS does not keep order. Every trip push carries `tripId`, `version` and `eventId`, and the client keeps only the highest `version` per trip. A dedup record per push would cost a write per message to stop something harmless. The offer push is the exception: the driver-offers consumer pushes only an `offerId` it has not recorded, and records it only after the push succeeds, so a failed push is retried.

**Gone sockets.** A push that gets `GoneException` (410) removes that connection item, and the message still counts as handled. Any other push error fails the SQS message or stream record, so it is retried.

**The map is best effort.**
- **Throttle.** At most one `car` or `driver_position` per driver every 3 s, held in its own item (`THROTTLE#position#<driverId>`, one partition per driver), never on the driver item. A handler that wrote the driver item would trigger itself through the stream.
- **`car.left`.** It has its own throttle scope, so a recent `car` never holds it back. An OFFLINE driver sends it at most every 3 s. An on-trip driver sends it once per trip (`THROTTLE#left#<driverId>#<tripId>`), so watchers along the route learn nothing about where the car goes.
- **Opening the map.** On `watch`, the passenger also gets a `car` for each available driver already parked in the 3 × 3 cells (at most 50, nearest first). That is a read of the availability index, the same one dispatch uses. Without it, a parked car would appear only when it moved. The snapshot is limited to one per connection every 10 s, so one socket cannot sweep the city cell by cell. Watching itself is not limited, and the `driverId` on a car is stable, so a determined passenger with many sockets could still follow a driver around the map. Pseudonymous ids and a limit on how far from the passenger's own position they may watch are not built yet.
- **Cars that change cell.** The stream image has no previous value (`NEW_IMAGE`), so a car that moves to another cell is not announced to the old cell. The client drops any car not updated for 30 s.
- **Late records.** Stream records older than 30 s are skipped, so a late position does not reach a later trip's passenger.
- **Failures.** The positions mapping retries 3 times and has no failure destination, because the next position replaces a lost one.

**One IAM role.** All functions share osls's default role (the deferred item from ADR 0004). osls adds `execute-api:ManageConnections` on `execute-api:*:*:*/@connections/*` to that role whenever a service has a WebSocket API. So any function in the service can push to any WebSocket API in the account, and a narrower statement next to it would restrict nothing. Per-function roles need a plugin or hand-written roles. They are left for a later change and recorded here as an accepted risk.

## Consequences

- e2e covers the whole path on Floci:
  - a refused bad token;
  - a car on the map, then the offer pushed to the driver;
  - `trip.requested` pushed to the passenger, `trip.accepted` to both;
  - `car.left` once the driver is on the trip, then the driver's position reaching only that passenger.

  With the notifier's mapping disabled, it fails.
- `make demo-map` and `demo/map.html` show the cars moving. The page holds the pasted token in memory only.
- **Limits:**
  - no presence ("driver is online" is still the HTTP availability);
  - no re-offer when nobody accepts;
  - a record from the previous trip that arrives late, but within 30 s, can give the new trip's passenger that driver's position from a few seconds earlier (the driver item does not name its trip).
