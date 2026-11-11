# ridecore Real Time (Plan 2b of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push trip updates, driver offers and car positions to passengers and drivers over an API Gateway WebSocket API, driven by the Plan 2a events, plus a demo map page.

**Architecture:** A WebSocket API (owned by osls) authenticates `$connect` with the existing dev JWT and stores one connection item per socket in the ridecore table. Three pushers read those items: a **notifier** consumer (new SQS queue fed by an EventBridge rule for every `trip.*` event) unicasts state changes to the trip's passenger and driver; the existing **driver-offers** consumer unicasts each new offer to the driver; a **positions** Lambda on a second table-stream mapping (driver items only) broadcasts available cars to passengers watching that geohash cell and its neighbours, and unicasts an on-trip driver's position to that trip's passenger. The real-time layer never writes trip state. `demo/map.html` (Leaflet) shows it.

**Tech Stack:** as Plan 2a, plus `@aws-sdk/client-apigatewaymanagementapi` (ships in the Lambda image, ADR 0004 probe (g)), Node's global `WebSocket` client in tests and scripts, Leaflet 1.9.4 (demo page only, from cdnjs with SRI).

**Spec:** `docs/superpowers/specs/2026-11-09-ridecore-design.md` §5b (real time), §5 "Authorization per resource", "Idempotency", "Observability"; §9 step 2. ADR 0004 (event path this plan builds on).

## Global Constraints

- Everything in Plan 2a's Global Constraints still holds (Node `>=26.13.0` dev/CI, Lambda `nodejs24.x`, strict TS, ESM with erasable syntax where CDK/scripts strip types, no client names, Floci only, one owner per resource with one-way references, English, no `Co-Authored-By`, no push without the owner's order, `TripEvent` stays `schemaVersion: 1`).
- Branch `feat/realtime`.
- Resource names (fixed): queue `ridecore-notifications` + `ridecore-notifications-dlq` (same redrive 3 / visibility 60 s / DLQ 14 d as Plan 2a); WebSocket routes `$connect`, `$disconnect`, `$default`.
- Timings (fixed): connection item TTL = connect time + 2 h 10 min (API Gateway caps a socket at 2 h); position broadcast throttle 3 s per driver; demo client drops a car not updated for 30 s and sends a `ping` every 5 min (API Gateway closes a socket idle for 10 min).
- Outbound messages are JSON with `type` and `schemaVersion: 1`; the token is never logged, never put in a log line's fields, never echoed back.
- Demo page: no token embedded in the file; OpenStreetMap tiles with their attribution.

## Rulings on the spec (flagged for owner review)

1. **Unicast is routed by actor, not by a trip stored on the connection** (spec §5b: the connection item records "the current trip (if any)"). Every `TripEvent.payload` already carries `passengerId` and `driverId`, so the notifier finds the sockets of those two actors; nothing has to update connection items when a trip changes. Cost if wrong: one GSI query per recipient per push.
2. **Pushes are not deduplicated server side.** Each push carries `tripId`, `version` and `eventId`; the client keeps the highest `version` per trip and drops older or equal ones (spec: "a consumer ignores an event older than what it already applied"). A duplicate push is harmless; a dedup record per push would cost a write per message. Exception: the offer push happens only when the driver-offers consumer sees the `offerId` for the first time (it already dedups).
3. **Who gets which trip event:** every `trip.*` event goes to the trip's passenger and, when `driverId` is present, to its driver. Offers reach drivers only through the offer push (a `trip.requested` has no `driverId`).
4. **A car leaving the map:** the stream keeps `NEW_IMAGE` only (changing it replaces the table on real AWS). When a driver item turns `OFFLINE` or `ON_TRIP`, the positions Lambda sends `car.left` to watchers of the cell stored on the item; a car that moves to another cell disappears from the old cell's watchers by the client's 30 s expiry.
5. **Throttle state lives in its own item** (`THROTTLE#position` / `DRIVER#<id>`, TTL 1 h), written with a conditional put. The positions Lambda never writes the driver item, so it cannot trigger itself through the stream.
6. **The on-trip driver's position goes only to that trip's passenger**, never to cell watchers (privacy). It costs two reads per update (driver reservation → trip), within the 3 s throttle.
7. **One IAM role for all Lambdas stays** (Plan 2a deferred minor). osls has no per-function roles without a plugin; adding one is a dependency decision for the owner. `execute-api:ManageConnections` is scoped to this API's `@connections` ARN. Recorded in ADR 0005 with the cost: the API Lambda can also push to sockets.

## Review Focus

1. A socket that vanished without `$disconnect` → `PostToConnection` returns 410 Gone → its item is deleted, the other recipients still get the message, and the consumer does not fail the SQS message. Any other push error (throttling, 5xx) fails the message so SQS retries it.
2. `$connect` with a missing, malformed, expired or `alg: none` token → rejected (401), no connection item written, the token not logged.
3. A driver token sending `watch`, or a passenger token sending `position` → an `error` message back, nothing written.
4. A driver sending positions every 200 ms → at most one broadcast per 3 s, and the positions Lambda never writes the driver item.
5. A driver going `ON_TRIP` → cell watchers get `car.left` and no more of that driver's positions; only the trip's passenger gets them.

Tests: 1 → Tasks 2, 4; 2, 3 → Task 3; 4, 5 → Task 6.

## File Structure

```
src/events/names.ts                    # + NOTIFICATIONS_QUEUE_NAME
src/http/auth.ts                       # + verifyRawToken (verifyToken delegates to it)
src/infra/dynamo/keys.ts               # + connectionKey, connectionActorGsi1, watchGsi2, throttleKey
src/infra/dynamo/connection-repo.ts    # connection items: put, delete, watch, byActor, watchersOf
src/infra/dynamo/throttle-repo.ts      # once-per-window conditional put
src/realtime/messages.ts               # inbound zod schemas, outbound message types
src/realtime/pusher.ts                 # Pusher (PostToConnection), sendToActor, sendToConnections
src/realtime/ws.ts                     # $connect / $disconnect / $default handlers + Lambda entry
src/realtime/positions.ts              # driver-item stream → car / car.left / driver_position
src/events/consumers/notifier.ts       # trip.* → passenger and driver sockets
src/events/consumers/driver-offers.ts  # + push the offer on first sight
infra/cdk/stateful-stack.ts            # + notifications queue, DLQ, rule for every trip.* event
scripts/build.ts  scripts/cdk-env.ts  serverless.yml  Makefile
scripts/move-drivers.ts                # moves the seeded drivers so cars move on the map
demo/map.html
docs/decisions/0005-real-time.md  README.md
tests/unit/realtime/**  tests/unit/events/notifier.test.ts  tests/integration/connections.test.ts
tests/e2e/realtime.test.ts
```

---

### Task 0: Floci spike for WebSocket APIs (gate)

**Files:** `docs/decisions/0005-real-time.md` (spike section only). Spike code lives outside the repo (scratchpad) and its Floci resources are deleted afterwards, as in ADR 0004.

- [ ] **Step 1: Run each probe on Floci with a throwaway osls service and record a table like ADR 0004's** (Check | Result | Evidence):
  - (a) osls `websocket` events (`$connect`, `$disconnect`, `$default`) deploy to Floci; the client URL a Node `WebSocket` can open.
  - (b) What `$connect` receives: `queryStringParameters`, `headers`, `Sec-WebSocket-Protocol`. Can a handler accept a subprotocol `ridecore.v1, <jwt>` and return it so the browser keeps the socket? Can it reject with 401?
  - (c) `PostToConnection` from a Lambda: the management endpoint on Floci (and the real-AWS form `https://<apiId>.execute-api.<region>.amazonaws.com/<stage>`), and that a message reaches the client.
  - (d) `PostToConnection` to a closed connection → `GoneException` (410).
  - (e) `$default` receives a client message body.
  - (f) A second stream mapping on the ridecore table with filter `{"eventName":["INSERT","MODIFY"],"dynamodb":{"NewImage":{"entity":{"S":["DRIVER"]}}}}` runs next to the publisher's and sees only driver items.
  - (g) Node 26 global `WebSocket` against the Floci URL (for e2e).
- [ ] **Step 2: Decide and write the outcome under the table.** Token transport: subprotocol if (b) passes, else `?token=` query string (record why; never logged). If (a), (c) or (e) fails: the spec fallback — a local `ws` adapter `src/local/ws-server.ts` that calls the same three handlers with `APIGatewayProxyWebsocketEventV2`-shaped events and implements `Pusher` in memory; serverless.yml stays valid for AWS. Every later task is written against `Pusher` and that event shape, so only Task 7's wiring differs. Record the management-endpoint env var `RIDECORE_WS_MANAGEMENT_URL` and the client URL `RIDECORE_WS_URL` with their Floci and AWS values.
- [ ] **Step 3: Commit** `docs(adr): Floci spike for WebSocket APIs`.

### Task 1: Connection and throttle items

**Files:** Modify `src/events/names.ts`, `src/infra/dynamo/keys.ts`. Create `src/infra/dynamo/connection-repo.ts`, `src/infra/dynamo/throttle-repo.ts`. Test `tests/integration/connections.test.ts`.

**Interfaces — Produces:**
- `NOTIFICATIONS_QUEUE_NAME = 'ridecore-notifications'` in names.ts.
- keys: `connectionKey(id) = { PK: 'CONN#'+id, SK: 'META' }`; `connectionActorGsi1(role, actorId, id) = { GSI1PK: 'CONNACTOR#'+role+'#'+actorId, GSI1SK: 'CONN#'+id }`; `watchGsi2(cell, id) = { GSI2PK: 'WATCH#'+cell, GSI2SK: 'CONN#'+id }` (GSI2 is shared with the sparse `AVAIL#<cell>` index; the prefixes never collide); `throttleKey(scope, id) = { PK: 'THROTTLE#'+scope, SK: id }`.
- `type Connection = { connectionId: string; actor: Actor; connectedAt: string; watchCell?: string }`
- `class ConnectionRepo(doc, table)`: `put(c: Connection, now: Date): Promise<void>` (entity `CONNECTION`, `expiresAt` = now + 7800 s in epoch seconds); `remove(connectionId): Promise<void>`; `watch(connectionId, cell): Promise<void>` (sets `watchCell` and the GSI2 keys; conditional on the item existing); `byActor(actor: Actor): Promise<string[]>`; `watchersOf(cells: readonly string[]): Promise<string[]>` (one GSI2 query per cell, paginated with the driver repo's `MAX_QUERY_PAGES`, de-duplicated).
- `class ThrottleRepo(doc, table)`: `once(scope, id, now: Date, windowMs: number): Promise<boolean>` — conditional put that succeeds only if no item exists or its `at` is older than `now - windowMs`; `expiresAt` = now + 1 h. `false` on the conditional failure, rethrows anything else.

- [ ] **Step 1: Write the failing integration tests** (Floci, shared table helper): put → `byActor` returns the id; a passenger and a driver with the same id never see each other's sockets; `watch` then `watchersOf([cell, other])` returns it once; `remove` → both lookups empty; `watch` on a removed connection throws nothing and writes nothing (`ConditionalCheckFailed` swallowed — the socket is gone); `once` true, then false within 3000 ms, then true at +3001 ms; the item never has `entity: 'DRIVER'` (positions filter).
- [ ] **Step 2: Run** `npm run test:integration -- connections` → FAIL (modules missing).
- [ ] **Step 3: Implement** keys, both repos.
- [ ] **Step 4: Run** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(realtime): connection and throttle items`.

### Task 2: Messages, raw-token auth and the pusher

**Files:** Modify `src/http/auth.ts`. Create `src/realtime/messages.ts`, `src/realtime/pusher.ts`. Tests `tests/unit/http/auth.test.ts` (extend), `tests/unit/realtime/pusher.test.ts`.

**Interfaces — Produces:**
- `verifyRawToken(token: string, secret: string): Promise<Actor>` — same rules and 401 messages as `verifyToken`; `verifyToken` extracts the bearer and delegates.
- messages.ts inbound: `clientMessageSchema` = discriminated union on `action`: `{ action: 'watch', lat, lng }`, `{ action: 'position', lat, lng }`, `{ action: 'ping' }` (lat/lng ranges as `parsePosition`).
- messages.ts outbound (`schemaVersion: 1` on each): `{ type: 'trip', event: { eventId, type, tripId, version, occurredAt, payload } }`; `{ type: 'offer', offer: { offerId, tripId, offeredAt } }`; `{ type: 'car', driverId, category, position, at }`; `{ type: 'car.left', driverId }`; `{ type: 'driver_position', tripId, position, at }`; `{ type: 'pong' }`; `{ type: 'error', code, message }`. Export `type ServerMessage`. The `trip` push never includes `correlationId` or anything outside that list.
- pusher.ts: `interface Pusher { send(connectionId: string, message: ServerMessage): Promise<'sent' | 'gone'> }`; `createApiGatewayPusher(endpoint: string): Pusher` (`GoneException` → `'gone'`, anything else rethrows); `sendToConnections(pusher, connections: Pick<ConnectionRepo,'remove'>, ids: readonly string[], message): Promise<{ sent: number; gone: number }>` — sends to all ids (in parallel, `Promise.allSettled`), removes the gone ones, and after all settle rethrows the first non-Gone error; `sendToActor(pusher, connections: Pick<ConnectionRepo,'byActor'|'remove'>, actor, message)` = `byActor` then `sendToConnections`.

- [ ] **Step 1: Write the failing tests:** `verifyRawToken` accepts a signed token, rejects expired / `alg: none` / wrong role with 401; `sendToConnections` with a fake pusher where `b` is gone and `c` throws a 500: `a` sent, `b` removed, the call rejects with the 500 *after* `a` was sent and `b` removed; all gone → `{ sent: 0, gone: n }`, no throw; `createApiGatewayPusher` maps a `GoneException`-named error to `'gone'` (client stubbed with `aws-sdk-client-mock` if already a dev dependency, else a hand fake of `send`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/http/auth.test.ts tests/unit/realtime` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(realtime): message contract, raw-token auth, pusher`.

### Task 3: WebSocket handlers

**Files:** Create `src/realtime/ws.ts`. Test `tests/unit/realtime/ws.test.ts`.

**Interfaces — Consumes:** Task 1 repos, Task 2 `verifyRawToken`, `clientMessageSchema`, `Pusher`; `DriverService.setPosition` and `cellOf` from Plan 1. **Produces:** `createWsHandler(deps: { connections: ConnectionRepo-like; drivers: Pick<DriverService,'setPosition'>; pusher: Pusher; secret: string; log: Logger; now?: () => Date }): (event: APIGatewayProxyWebsocketEventV2) => Promise<{ statusCode: number; headers?: Record<string,string>; body?: string }>`; Lambda `handler` (bundled to `dist/ws.mjs`) building deps from env (`RIDECORE_WS_MANAGEMENT_URL`, `RIDECORE_JWT_SECRET`, table).

Behaviour by `requestContext.routeKey`:
- `$connect`: token from the transport Task 0 chose; valid → `put` and 200 (echo the `ridecore.v1` subprotocol header if that transport); invalid → 401, nothing written. Log `connected` with `connectionId`, role, actor id — never the token or the query string.
- `$disconnect`: `remove`, 200.
- `$default`: look up the connection's actor (`GetItem` on `connectionKey`; missing → 200 with nothing done). Parse body with `clientMessageSchema`; invalid → push `error` `INVALID_MESSAGE`. `watch` from a passenger → `connections.watch(id, cellOf(p))`; from a driver → `error` `FORBIDDEN`. `position` from a driver → `drivers.setPosition(actor, p)` (its `DomainError`s become `error` pushes with their code); from a passenger → `error` `FORBIDDEN`. `ping` → `pong`. Always 200 (the reply travels as a push).

- [ ] **Step 1: Write the failing unit tests** (fakes for repos, driver service and pusher): valid connect stores `{ connectionId, actor }`; missing / expired / `alg: none` → 401 and no `put`; a log spy never receives a string containing the token; disconnect removes; driver `watch` → `error FORBIDDEN`, no `watch` call; passenger `position` → `error FORBIDDEN`, no `setPosition`; driver `position` `{ lat: 91 }` → `error INVALID_MESSAGE`; driver `position` while `ON_TRIP` is allowed (setPosition decides); passenger `watch` stores `cellOf(p)`; `ping` → `pong`; unknown connection id on `$default` → no push, no throw.
- [ ] **Step 2: Run** `npx vitest run tests/unit/realtime/ws.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(realtime): WebSocket connect, disconnect and message routes`.

### Task 4: Notifier consumer and its queue

**Files:** Modify `infra/cdk/stateful-stack.ts`, `infra/cdk/stateful-stack.test.ts`. Create `src/events/consumers/notifier.ts`. Test `tests/unit/events/notifier.test.ts`.

**Interfaces — Consumes:** `sqsHandler`, `fromEventBridge` (Plan 2a), `sendToActor`. **Produces:** CDK queue `ridecore-notifications` via the existing `consumerQueue` helper (outputs `NotificationsQueueArn`, `NotificationsQueueUrl`, `NotificationsDlqUrl`) and a rule `TripEventsToNotifications` matching `source: [EVENT_SOURCE]` (every detail-type); `createNotifierConsumer(deps: { connections; pusher; log })`; Lambda `handler` → `dist/notifier.mjs`.

- [ ] **Step 1: Write the failing tests:** CDK — queue + DLQ with redrive 3, and a rule on bus `ridecore` whose pattern has `source` only; consumer — a `trip.accepted` event pushes one `trip` message to the passenger's and the driver's sockets with `version` and `eventId`, no `correlationId`; a `trip.requested` (no `driverId`) pushes to the passenger only; recipient with no sockets → acked, nothing sent; a gone socket → removed, message acked; a 500 from the pusher → the record is in `batchItemFailures`.
- [ ] **Step 2: Run** `npx vitest run infra/cdk tests/unit/events/notifier.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(realtime): notifier consumer pushes trip events to participants`.

### Task 5: Push offers to drivers

**Files:** Modify `src/events/consumers/driver-offers.ts`, `tests/unit/events/driver-offers-consumer.test.ts` (create if absent).

**Interfaces — Consumes:** `sendToActor`. Deps gain `connections` and `pusher`.

- [ ] **Step 1: Write the failing tests:** first sight of an `offerId` → one `offer` push to `{ role: 'driver', id: driverId }` carrying `offerId`, `tripId`, `offeredAt`; duplicate → no push; pusher 500 → record fails and the offer stays unmarked, so the retry pushes it (push first, then `markOnce`; a crash between them repeats a push, harmless per Ruling 2).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(realtime): push new offers to the driver's sockets`.

### Task 6: Positions from the driver stream

**Files:** Create `src/realtime/positions.ts`. Test `tests/unit/realtime/positions.test.ts`.

**Interfaces — Consumes:** `ConnectionRepo.watchersOf`, `ThrottleRepo.once`, `sendToConnections`, `sendToActor`, `TripRepo` reads (driver reservation → trip; use the existing read methods, add `activeTripOf('DRIVER', id)` to `TripRepo` only if none exists). **Produces:** `createPositionsHandler(deps)`: `(event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>`; Lambda `handler` → `dist/positions.mjs`.

Per record (unmarshall `NewImage`; skip anything whose `entity` is not `DRIVER`):
- `AVAILABLE` with a position → if `throttle.once('position', driverId, now, 3000)`: `car` to `watchersOf([cell, ...neighbours(cell)])`.
- `OFFLINE` with a stored cell → `car.left` to the same 9 cells' watchers (not throttled).
- `ON_TRIP` → if `throttle.once('position', …)`: `car.left` to the 9 cells' watchers (NEW_IMAGE cannot tell which record changed the availability, so every throttled ON_TRIP record sends it) and, if the driver has an active trip, `driver_position` to that trip's passenger.
- A thrown push error fails that record (`batchItemFailures` with its sequence number); the stream retries it.

- [ ] **Step 1: Write the failing tests:** AVAILABLE twice within 3 s → one broadcast; the handler never calls anything that writes `driverKey` (repo fakes record every write; assert none targets `DRIVER#`); ON_TRIP → watchers get `car.left`, never `car`, and the trip's passenger gets `driver_position`; OFFLINE → `car.left`; a `TRIP#…/META` record → ignored; a 500 on one record → only that record's sequence number in `batchItemFailures`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit** `feat(realtime): broadcast cars by cell and the on-trip driver to its passenger`.

### Task 7: Wiring (build, osls, CDK outputs, Makefile)

**Files:** `scripts/build.ts`, `scripts/cdk-env.ts`, `tests/unit/scripts/cdk-env.test.ts`, `serverless.yml`, `Makefile`, `.github/workflows/ci.yml` (only if a new step is needed).

- [ ] **Step 1: Failing test:** `cdk-env` maps `NotificationsQueueArn/Url`, `NotificationsDlqUrl` and `--dummy` emits placeholders for them.
- [ ] **Step 2: Run** `npx vitest run tests/unit/scripts/cdk-env.test.ts` → FAIL; implement → PASS.
- [ ] **Step 3: Wire** build entries `ws`, `notifier`, `positions`; osls functions `ws` (routes `$connect`, `$disconnect`, `$default`), `notifier` (SQS, `ReportBatchItemFailures`), `positions` (stream mapping, filter from Task 0 (f), `ReportBatchItemFailures`, retries 3, no on-failure destination — a lost position is superseded by the next); env `RIDECORE_WS_MANAGEMENT_URL` (Task 0 value per stage); IAM `execute-api:ManageConnections` on this API's `@connections/*`. `deploy-api` writes `RIDECORE_WS_URL` and `RIDECORE_WS_MANAGEMENT_URL` to `.env.deploy`. If Task 0 chose the fallback: `make dev` also starts `src/local/ws-server.ts`.
- [ ] **Step 4: Verify:** `make package` (offline, dummy values) and `npx cdk synth --quiet` pass; `make down && make up` deploys from scratch; `npm run test:integration` and `make e2e` still pass.
- [ ] **Step 5: Commit** `build(realtime): deploy the WebSocket API, notifier and positions Lambdas`.

### Task 8: End-to-end over sockets

**Files:** Create `tests/e2e/realtime.test.ts`.

- [ ] **Step 1: Write the test** (Node `WebSocket`, URL from `RIDECORE_WS_URL`, dev tokens; poll helper as in `trip-flow.test.ts`, timeout 60 s per expectation): a passenger socket sends `watch` at the seed centre; a driver near it goes AVAILABLE via HTTP and its socket sends `position` → the passenger receives `car` for that driver; passenger requests a trip (HTTP) → the driver socket receives `offer` for it and the passenger socket receives `trip` `trip.requested`; driver accepts (HTTP) → both receive `trip.accepted` with a higher `version`; the watcher receives `car.left`; the driver sends `position` → the passenger receives `driver_position` for the trip; cleanup cancels/completes the trip. A connection with a bad token fails to open.
- [ ] **Step 2: Prove it can fail:** run it with the notifier's SQS mapping disabled (as Plan 2a did) → FAIL on `trip.accepted`; re-enable.
- [ ] **Step 3: Run** `make e2e` → PASS (both e2e files).
- [ ] **Step 4: Commit** `test(e2e): trip updates, offers and positions over WebSocket`.

### Task 9: Demo map page

**Files:** Create `demo/map.html`, `scripts/move-drivers.ts`. Modify `Makefile` (`demo-map`), `scripts/dev-token.ts` only if it cannot already print a passenger token.

- [ ] **Step 1: `scripts/move-drivers.ts`:** every 2 s moves each seeded driver a few metres along a small loop around the seed centre over the driver socket (`position`), for `--seconds N` (default 120). Unit-test the pure step function (stays within ~500 m of the centre; deterministic for a seed).
- [ ] **Step 2: `demo/map.html`:** Leaflet 1.9.4 (cdnjs, pinned, SRI), OSM tiles with attribution; inputs for WS URL and a token (pasted, kept only in memory); on open sends `watch` at the map centre; draws `car` markers, removes on `car.left` or after 30 s; shows `trip` state changes in a side list keeping the highest `version` per trip; `driver_position` moves a distinct marker; `ping` every 5 min. Opens from `file://`.
- [ ] **Step 3: `make demo-map`:** prints a passenger token and the WS URL, the path of `demo/map.html`, and runs `move-drivers`. Check by hand in a browser: cars move; requesting a trip in another terminal shows its states.
- [ ] **Step 4: Commit** `feat(demo): live map page`.

### Task 10: ADR 0005 and README

- [ ] **Step 1: ADR 0005 decisions** (after the spike table): routing by actor, delivery patterns, push table (Ruling 3), client-side version check, `car.left` + expiry, throttle item, token transport, ownership (WebSocket API in osls, connections in the CDK table), one IAM role (Ruling 7), limits (no presence, no re-offer, positions are best effort).
- [ ] **Step 2: README:** status line (Plan 2b built), a "Real time" bullet, the diagram gains the WebSocket path, `make demo-map` section, test table row for the realtime e2e, ADR 0005 link, roadmap item 2 marked done.
- [ ] **Step 3: Commit** `docs: real-time ADR and README`.
