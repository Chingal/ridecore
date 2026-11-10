# ridecore Core (Plan 1 of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the toolchain on Floci, then build the trip core: domain state machine, DynamoDB persistence with transactions and outbox items, drivers and dispatch offers, auth/authorization, idempotency, HTTP API on Lambda (runnable locally), and CI.

**Architecture:** Pure domain code (no AWS imports) in `src/domain`; DynamoDB single-table repositories in `src/infra/dynamo`; Lambda HTTP handlers in `src/http` that a local adapter (`src/local/server.ts`) can also serve. CDK owns stateful resources (`infra/cdk`); Serverless Framework owns functions (`serverless.yml`), reading CDK outputs one way only. Event delivery (outbox publisher, EventBridge, SQS, SNS) is Plan 2; this plan only writes outbox items.

**Tech Stack:** Node.js 26.13.0+, TypeScript (strict, ESM), AWS SDK v3 (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`), AWS CDK v2, Serverless Framework (v4 or the OSS v3-compatible fork, decided in Task 0), Vitest, ESLint + typescript-eslint, zod, jose, ngeohash, Floci via Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-09-ridecore-design.md`

## Global Constraints

- Node `>=26.13.0` for development, tests and CI (`.nvmrc` = `26.13.0`, `engines.node` = `>=26.13.0`). Code must also run on Node 24 (no Node-26-only APIs) in case Lambda falls back to `nodejs24.x`.
- Lambda runtime `nodejs26.x`; fallback `nodejs24.x` only if Task 0 proves a tool rejects 26 (record in ADR 0001).
- TypeScript `strict: true`; no `any` in `src/`.
- No code, names, branding or data from the original 2016-2018 client platform; no client names anywhere.
- Running locally and passing CI must need no AWS account, paid service or real secret. Test JWT secret is a fixed non-secret value in `.env.example`.
- Code, comments, docs and commit messages in English. Commits without `Co-Authored-By`. No `git push` without the owner's order.
- Floci endpoint `http://localhost:4567`, region `us-east-1`, dummy credentials `test/test`.
- Error body is always `{"error":{"code":string,"message":string}}`. Status codes: 400 validation, 401 bad/missing token, 403 wrong role, 404 not found or not yours, 409 state/active-trip/race conflict, 422 idempotency-key mismatch or rating window closed.
- Only `STANDARD` trips; one active trip per passenger and per driver; active = `REQUESTED | ACCEPTED | DRIVER_ARRIVED | IN_PROGRESS`.

## Review Focus

1. Two drivers accept the same trip at the same moment → exactly one 200, the other 409, and the loser keeps no active-trip reservation.
2. A passenger cancels while a driver accepts → exactly one wins; trip state and both reservations stay consistent.
3. A client retries `POST /trips` with the same `Idempotency-Key` → same trip returned, no second trip; same key with a different body → 422.
4. Malformed input (lat outside −90..90, lng outside −180..180, origin equal to destination, missing fields, non-JSON body) → 400 with a readable message, never a 500.
5. A passenger reads, cancels or rates another passenger's trip → 404; a rating after 24 h or a second rating → 422 / 409.

Each line has its test in the owning task (Tasks 3, 4, 6, 7).

## File Structure

```
.nvmrc  package.json  tsconfig.json  eslint.config.js  vitest.config.ts  Makefile
docker-compose.yml  .env.example  serverless.yml
.github/workflows/ci.yml
docs/decisions/0001-toolchain-spike.md
spike/                         # Task 0 throwaway probes (deleted at end of Task 0 except README notes)
infra/cdk/app.ts  infra/cdk/stateful-stack.ts  infra/cdk/stateful-stack.test.ts
src/domain/trip.ts             # Trip type, states, transition(), actor rules
src/domain/fare.ts             # haversineKm(), estimateFare()
src/domain/errors.ts           # DomainError(code, status, message)
src/domain/events.ts           # TripEvent type + toEvent()
src/infra/dynamo/client.ts     # DocumentClient from env
src/infra/dynamo/keys.ts       # key builders
src/infra/dynamo/trip-repo.ts  # create/transition/get/history
src/infra/dynamo/driver-repo.ts
src/infra/dynamo/idempotency-repo.ts
src/app/dispatch.ts            # offerTrip(), acceptTrip()
src/app/trips.ts               # use cases called by handlers
src/http/auth.ts  src/http/respond.ts  src/http/validate.ts  src/http/routes.ts  src/http/handler.ts
src/local/server.ts            # node:http → APIGatewayProxyEventV2 adapter
scripts/dev-token.ts           # mint passenger/driver tokens
tests/unit/**  tests/integration/**  tests/e2e/**
```

---

### Task 0: Toolchain compatibility spike

Answers spec §8 (a)-(e) before any product code depends on them.

**Files:**
- Create: `docker-compose.yml`, `spike/` probes, `docs/decisions/0001-toolchain-spike.md`

**Interfaces:**
- Produces: ADR 0001 stating, each with evidence (command + output excerpt): Lambda runtime value used (`nodejs26.x` or `nodejs24.x`); Serverless binary used (`serverless` v4 or OSS fork) and whether `package`/`deploy` need login; whether CDK deploys to Floci (and the tool used, e.g. `cdklocal`-style endpoint override); whether EventBridge → SQS and DynamoDB Streams → Lambda work on Floci; the chosen local/CI execution path (deploy to Floci vs local adapter).

- [ ] **Step 1:** `docker-compose.yml` with service `floci` (image `floci/floci:2.4.0` or newer, port `4567:4567`, `FLOCI_BASE_URL=http://localhost:4567`, in-memory storage). Run `docker compose up -d floci` and `aws --endpoint-url http://localhost:4567 dynamodb list-tables`. Expected: `{"TableNames": []}`.
- [ ] **Step 2:** Deploy a hello Lambda (`export const handler = async () => ({ v: process.version })`) with runtime `nodejs26.x` via AWS CLI against Floci and invoke it. Expected: payload `v` starts with `v26.`. If rejected, repeat with `nodejs24.x` and record both outputs.
- [ ] **Step 3:** In `spike/sls/`, a minimal `serverless.yml` (one function, `httpApi` GET `/ping`, runtime from Step 2) and run `serverless package`, then `serverless deploy` with endpoint override to Floci. Record whether login is required. If v4 requires login for `package`, retry with the OSS v3-compatible fork and record.
- [ ] **Step 4:** In `spike/cdk/`, a stack with one DynamoDB table (stream enabled) and run `cdk synth` and deploy to Floci. Expected: `aws ... dynamodb describe-table` shows the table with `StreamSpecification`.
- [ ] **Step 5:** Probe EventBridge → SQS (put rule, put event, receive message) and DynamoDB Streams → Lambda (event source mapping, write item, check Lambda log). Record pass/fail for each.
- [ ] **Step 6:** Write ADR 0001 with the decisions in Interfaces and the fallback chosen for any failure (spec §8). Delete `spike/` probe code (keep only what the ADR quotes).
- [ ] **Step 7:** Commit `docs: toolchain spike results (ADR 0001)`.

**Stop rule:** if Step 2 fails for both 26 and 24, or Steps 3 and 4 both fail, stop and report to the owner before Task 1.

---

### Task 1: Project scaffold + domain state machine

**Files:**
- Create: `.nvmrc` (exists), `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `Makefile`, `.env.example`, `src/domain/trip.ts`, `src/domain/errors.ts`, `src/domain/events.ts`
- Test: `tests/unit/domain/trip.test.ts`

**Interfaces:**
- Produces:
  - `type TripState = 'REQUESTED'|'ACCEPTED'|'DRIVER_ARRIVED'|'IN_PROGRESS'|'COMPLETED'|'RATED'|'CANCELLED'`
  - `type Actor = { id: string; role: 'passenger'|'driver' }`
  - `type LatLng = { lat: number; lng: number }`
  - `interface Trip { id; passengerId; driverId?: string; serviceType: 'STANDARD'; origin: LatLng; destination: LatLng; state: TripState; fareEstimate: number; finalFare?: number; rating?: { score: 1|2|3|4|5; comment?: string }; cancellation?: { by: 'passenger'|'driver'; reason?: string }; timestamps: Partial<Record<TripState, string>>; version: number; createdAt: string }`
  - `type TripAction = { type: 'ACCEPT'; driverId: string } | { type: 'ARRIVE' } | { type: 'START' } | { type: 'COMPLETE' } | { type: 'RATE'; score: number; comment?: string } | { type: 'CANCEL'; reason?: string }`
  - `transition(trip: Trip, action: TripAction, actor: Actor, now: Date): Trip` — returns a new trip with `version + 1` and `timestamps[newState] = now.toISOString()`; throws `DomainError`.
  - `isActive(state: TripState): boolean`
  - `class DomainError extends Error { constructor(code: string, status: 400|401|403|404|409|422, message: string) }`
  - `type TripEvent = { eventId: string; type: 'trip.requested'|'trip.accepted'|'trip.driver_arrived'|'trip.started'|'trip.completed'|'trip.rated'|'trip.cancelled'; tripId: string; version: number; occurredAt: string; payload: Record<string, unknown> }` and `toEvent(before: Trip | null, after: Trip): TripEvent`

- [ ] **Step 1:** Scaffold: `package.json` (`"type": "module"`, `engines.node >=26.13.0`, scripts `lint`, `typecheck` = `tsc --noEmit`, `test:unit`, `test:integration`, `test:e2e`), strict `tsconfig.json`, ESLint flat config, Vitest config with projects `unit|integration|e2e` by folder. `Makefile` targets: `up` (compose up + deploy/seed per ADR 0001), `down`, `test`, `lint`. Run `npm run typecheck && npm run lint`. Expected: exit 0.
- [ ] **Step 2: Write failing tests** in `tests/unit/domain/trip.test.ts`:
  - happy path: REQUESTED →ACCEPT(driver d1, actor d1)→ ACCEPTED (driverId `d1`) →ARRIVE(d1)→ DRIVER_ARRIVED →START(d1)→ IN_PROGRESS →COMPLETE(d1)→ COMPLETED (`finalFare === fareEstimate`) →RATE(passenger, 5)→ RATED; version goes 1→6.
  - actor rules: ACCEPT/ARRIVE/START/COMPLETE by a passenger → `DomainError` status 403; ARRIVE by a driver other than `driverId` → 404; RATE by a driver → 403.
  - CANCEL allowed from REQUESTED (passenger), ACCEPTED and DRIVER_ARRIVED (passenger or assigned driver), records `cancellation.by`; CANCEL from IN_PROGRESS, COMPLETED, RATED, CANCELLED → 409 code `INVALID_TRANSITION`.
  - every other invalid transition (e.g. START from REQUESTED, COMPLETE from ACCEPTED) → 409 `INVALID_TRANSITION`.
  - RATE: score outside 1..5 or non-integer → 400; more than 24 h after `timestamps.COMPLETED` → 422 `RATING_WINDOW_CLOSED`; on RATED → 409 (second rating).
  - `isActive` true exactly for the four active states.
  - `toEvent` maps each transition to its event type and copies `version`.
- [ ] **Step 3:** Run `npx vitest run tests/unit/domain`. Expected: FAIL (module not found).
- [ ] **Step 4:** Implement `src/domain/trip.ts`, `errors.ts`, `events.ts` with the signatures above. Transition table is data (a `Record<TripState, Partial<Record<TripAction['type'], TripState>>>`) plus an allowed-actor check per action.
- [ ] **Step 5:** Run `npx vitest run tests/unit/domain`. Expected: PASS.
- [ ] **Step 6:** Commit `feat(domain): trip state machine and events`.

---

### Task 2: Fare + geo helpers

**Files:**
- Create: `src/domain/fare.ts`
- Test: `tests/unit/domain/fare.test.ts`

**Interfaces:**
- Produces: `haversineKm(a: LatLng, b: LatLng): number`; `estimateFare(origin: LatLng, destination: LatLng): number` = `Math.round(BASE_FARE + PER_KM * km)` with `BASE_FARE = 4000`, `PER_KM = 1800` (COP, exported constants); `validateLatLng(p: unknown): LatLng` throwing `DomainError(400,'INVALID_COORDINATES')` for lat ∉ [−90,90], lng ∉ [−180,180], non-numbers; `assertDistinct(origin, destination)` throwing 400 `SAME_ORIGIN_DESTINATION` when distance < 0.05 km.

- [ ] **Step 1: Failing tests:** `haversineKm` Popayán centre (2.4419,−76.6063) → airport (2.4545,−76.6093) ≈ 1.44 km (±0.05); `estimateFare` for that pair = `Math.round(4000 + 1800 * haversineKm(...))`; boundary tests for `validateLatLng` (90 ok, 90.0001 → 400, `"2.4"` → 400); `assertDistinct` with identical points → 400.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement. **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(domain): fare estimate and coordinate validation`.

---

### Task 3: Stateful CDK stack + DynamoDB trip repository

**Files:**
- Create: `infra/cdk/app.ts`, `infra/cdk/stateful-stack.ts`, `src/infra/dynamo/client.ts`, `src/infra/dynamo/keys.ts`, `src/infra/dynamo/trip-repo.ts`
- Test: `infra/cdk/stateful-stack.test.ts`, `tests/integration/trip-repo.test.ts`

**Interfaces:**
- Consumes: `Trip`, `TripEvent`, `transition`, `toEvent` (Task 1).
- Produces:
  - Table `ridecore` (name from env `RIDECORE_TABLE`, default `ridecore`): `PK`/`SK` strings, `GSI1` (`GSI1PK`,`GSI1SK`), `GSI2` (`GSI2PK`,`GSI2SK`), stream `NEW_IMAGE`, TTL attribute `expiresAt`, on-demand billing. CDK output `TableName`, `TableStreamArn`.
  - Item layout (`keys.ts`): trip `PK=TRIP#<id> SK=META`, `GSI1PK=PASSENGER#<pid>`, `GSI1SK=TRIP#<createdAt>#<id>`; active reservation `PK=PASSENGER#<pid>|DRIVER#<did> SK=ACTIVE` with `tripId`; outbox `PK=TRIP#<id> SK=EVENT#<version padded 6>` holding the `TripEvent`.
  - `TripRepo.create(trip: Trip, event: TripEvent): Promise<void>` — one `TransactWriteItems`: put trip (`attribute_not_exists(PK)`), put passenger reservation (`attribute_not_exists(PK)` → else `DomainError(409,'ACTIVE_TRIP_EXISTS')`), put outbox item.
  - `TripRepo.save(before: Trip, after: Trip, event: TripEvent): Promise<void>` — one transaction: update trip with condition `version = before.version` (else 409 `CONCURRENT_UPDATE`); put outbox item; if `after.state` is `ACCEPTED` put driver reservation (`attribute_not_exists` → 409 `DRIVER_BUSY`); if `after.state` is `COMPLETED` or `CANCELLED` delete passenger reservation and driver reservation (if any) with condition `tripId = after.id`.
  - `TripRepo.get(id: string): Promise<Trip | null>`; `TripRepo.history(passengerId: string, limit = 20): Promise<Trip[]>` newest first via GSI1.
  - `TripRepo.activeTripId(kind: 'PASSENGER'|'DRIVER', id: string): Promise<string | null>`

- [ ] **Step 1: Failing CDK assertion test:** `Template.fromStack(new StatefulStack(app,'T'))` has one `AWS::DynamoDB::Table` with the key schema, both GSIs, `StreamViewType: NEW_IMAGE`, `TimeToLiveSpecification.AttributeName: expiresAt`, `BillingMode: PAY_PER_REQUEST`. Run `npx vitest run infra/cdk` → FAIL; implement stack; → PASS.
- [ ] **Step 2: Failing integration tests** (`tests/integration/trip-repo.test.ts`, table created per test file against Floci from the CDK template or an equivalent `CreateTable`):
  - `create` then `get` round-trips the trip; outbox item `EVENT#000001` exists with type `trip.requested`.
  - second `create` for the same passenger while active → 409 `ACTIVE_TRIP_EXISTS`, and no second trip item exists.
  - `save` with stale `before.version` → 409 `CONCURRENT_UPDATE`.
  - Review Focus 1: two concurrent `save` calls accepting the same trip for drivers d1 and d2 (`Promise.allSettled`) → exactly one fulfilled; the rejected driver has no `DRIVER#…/ACTIVE` item.
  - Review Focus 2: concurrent ACCEPT (d1) and CANCEL (passenger) from REQUESTED → exactly one fulfilled; if CANCEL won, no reservations remain; if ACCEPT won, both reservations point to the trip.
  - completing a trip deletes both reservations; the passenger can then `create` a new trip.
  - `history` returns trips newest first.
- [ ] **Step 3:** Run `docker compose up -d floci && npx vitest run tests/integration/trip-repo.test.ts` → FAIL. **Step 4:** Implement `client.ts` (DocumentClient using `AWS_ENDPOINT_URL` when set), `keys.ts`, `trip-repo.ts`. Map `TransactionCanceledException` cancellation reasons to the 409 codes above. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(infra): stateful stack and transactional trip repository`.

---

### Task 4: Drivers, dispatch offers and accept

**Files:**
- Create: `src/infra/dynamo/driver-repo.ts`, `src/app/dispatch.ts`
- Test: `tests/integration/dispatch.test.ts`

**Interfaces:**
- Consumes: `TripRepo` (Task 3), `transition` (Task 1).
- Produces:
  - Driver item `PK=DRIVER#<id> SK=META` with `name`, `vehicle {plate, model, category}`, `availability: 'OFFLINE'|'AVAILABLE'|'ON_TRIP'`, `position?: LatLng`, `geohash5?`; sparse `GSI2PK=AVAIL#<geohash5>`, `GSI2SK=DRIVER#<id>` present only while `AVAILABLE` with a position.
  - `DriverRepo.upsert(driver)`, `DriverRepo.setAvailability(id, 'AVAILABLE'|'OFFLINE')` (409 `DRIVER_ON_TRIP` if on a trip), `DriverRepo.setPosition(id, LatLng)`, `DriverRepo.availableNear(p: LatLng, limit: number): Promise<Driver[]>` querying GSI2 for the geohash-5 cell and its 8 neighbours (`ngeohash.neighbors`), sorted by `haversineKm`, sliced to `limit`.
  - Offer item `PK=TRIP#<tripId> SK=OFFER#<driverId>` (+ `GSI1PK=DRIVER#<driverId>`, `GSI1SK=OFFER#<createdAt>` for "my offers").
  - `offerTrip(tripId: string): Promise<string[]>` — loads trip (must be REQUESTED), picks `availableNear(origin, 5)`, writes offer items, returns driver ids. (Plan 2 calls this from the `trip.requested` consumer and publishes to SNS.)
  - `acceptTrip(tripId: string, driver: Actor, now: Date): Promise<Trip>` — one transaction: condition check offer exists (else 404 `NOT_OFFERED`), condition check driver `availability = AVAILABLE` (else 409 `DRIVER_NOT_AVAILABLE`), the `TripRepo.save` items for ACCEPT, set driver `availability = ON_TRIP` and remove its GSI2 keys.
  - `listOffers(driverId: string): Promise<Trip[]>` — REQUESTED trips with an offer for this driver.
  - On COMPLETED/CANCELLED the assigned driver returns to `AVAILABLE` (same transaction as `TripRepo.save`; extend `save` via an optional `extraItems` parameter rather than a second write).

- [ ] **Step 1: Failing tests:** 7 drivers seeded around Popayán centre (5 within the cell/neighbours, 1 `OFFLINE`, 1 ~30 km away) → `offerTrip` returns exactly the 5 nearest available, nearest first; accept by a non-offered driver → 404; accept by an offered driver who went OFFLINE → 409; Review Focus 1 again at service level (two offered drivers accept concurrently → one 200-equivalent, other 409, loser stays `AVAILABLE`); after COMPLETE the driver is `AVAILABLE` and reappears in `availableNear`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(dispatch): driver availability, offers and transactional accept`.

---

### Task 5: Auth tokens and idempotency store

**Files:**
- Create: `src/http/auth.ts`, `src/infra/dynamo/idempotency-repo.ts`, `scripts/dev-token.ts`
- Test: `tests/unit/http/auth.test.ts`, `tests/integration/idempotency.test.ts`

**Interfaces:**
- Produces:
  - `signToken(actor: Actor, secret: string, ttlSeconds = 86400): Promise<string>` (HS256, claims `sub`, `role`); `verifyToken(header: string | undefined, secret: string): Promise<Actor>` → `DomainError(401,'UNAUTHENTICATED')` for missing, malformed, expired or bad-signature tokens. Secret from env `RIDECORE_JWT_SECRET` (`.env.example` has a fixed non-secret dev value).
  - `npm run token -- passenger p-1` prints a token (uses `signToken`).
  - `IdempotencyRepo.run<T>(actorId: string, key: string, requestHash: string, fn: () => Promise<{status: number; body: T}>): Promise<{status: number; body: T; replayed: boolean}>` — item `PK=IDEM#<actorId>#<key> SK=META`, `expiresAt` = now + 24 h. Claim with `attribute_not_exists`; on existing item: same `requestHash` and stored response → replay; different hash → `DomainError(422,'IDEMPOTENCY_KEY_REUSED')`; claimed but no response yet → 409 `REQUEST_IN_PROGRESS`. On `fn` failure delete the claim so the client can retry.

- [ ] **Step 1: Failing tests:** sign/verify round-trip; expired token → 401; token signed with another secret → 401; `Bearer` missing → 401. Idempotency (Review Focus 3): same key + same hash twice → second call `replayed: true`, `fn` called once; same key + different hash → 422; `fn` throws → a retry with the same key runs `fn` again.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(http): jwt auth and idempotency keys`.

---

### Task 6: Use cases, HTTP handlers, validation and authorization

**Files:**
- Create: `src/app/trips.ts`, `src/http/validate.ts`, `src/http/respond.ts`, `src/http/routes.ts`, `src/http/handler.ts`
- Test: `tests/unit/http/validate.test.ts`, `tests/integration/http.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: `handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2>` routing:

| Method & path | Role | Body | Success |
|---|---|---|---|
| `POST /trips` (Idempotency-Key required) | passenger | `{origin, destination}` | 201 trip |
| `GET /trips/{id}` | passenger owner or assigned/offered driver | — | 200 trip |
| `GET /me/trips` | passenger | — | 200 `{items: Trip[]}` |
| `POST /trips/{id}/cancel` (Idempotency-Key optional) | owner passenger or assigned driver | `{reason?}` | 200 trip |
| `POST /trips/{id}/rating` | owner passenger | `{score, comment?}` | 200 trip |
| `POST /trips/{id}/accept` | offered driver | — | 200 trip |
| `POST /trips/{id}/arrive` · `/start` · `/complete` | assigned driver | — | 200 trip |
| `PUT /drivers/me/availability` | driver | `{status: 'AVAILABLE'|'OFFLINE'}` | 200 driver |
| `PUT /drivers/me/position` | driver | `{lat, lng}` | 200 driver |
| `GET /drivers/me/offers` | driver | — | 200 `{items: Trip[]}` |

  Non-owners get 404 `TRIP_NOT_FOUND` (never 403) so trip ids cannot be probed. Wrong role on a route → 403 `FORBIDDEN_ROLE`. Unknown route → 404 `ROUTE_NOT_FOUND`. Every `DomainError` → its status and code; anything else → 500 `INTERNAL` with a generic message (details only in logs). Each response carries header `x-correlation-id` (from request header or new UUID), and every log line is JSON with that id.
  `src/app/trips.ts` exports `requestTrip`, `getTrip`, `listMyTrips`, `cancelTrip`, `rateTrip`, `advanceTrip(action: 'ARRIVE'|'START'|'COMPLETE')` taking `(actor, input, now)`.

- [ ] **Step 1: Failing unit tests** for `validate.ts` (zod schemas; Review Focus 4): non-JSON body → 400 `INVALID_JSON`; missing `destination` → 400 `VALIDATION_ERROR` with field path in message; lat 91 → 400; origin = destination → 400; `score: 4.5` → 400.
- [ ] **Step 2: Failing integration tests** calling `handler` with built events against Floci: full happy path passenger+driver (request → driver sets AVAILABLE+position before → `offerTrip` called directly → accept → arrive → start → complete → rate) returning the expected states; Review Focus 5: passenger B `GET`/`cancel`/`rating` on A's trip → 404; rating twice → 409; rating with clock > 24 h after completion (inject `now`) → 422; driver calling `POST /trips` → 403; no token → 401; `POST /trips` without `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`; retry with same key → same trip id, status 201, one trip in history (Review Focus 3); thrown non-domain error → 500 body without stack trace.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(http): trip and driver API with authorization`.

---

### Task 7: Local adapter, Serverless config, dev workflow

**Files:**
- Create: `src/local/server.ts`, `serverless.yml`, `scripts/seed.ts`
- Modify: `Makefile`, `.env.example`
- Test: `tests/e2e/trip-flow.test.ts`

**Interfaces:**
- Consumes: `handler` (Task 6), stack outputs (Task 3), ADR 0001 decisions.
- Produces:
  - `startLocalServer(port = 3000): Promise<http.Server>` translating Node requests to `APIGatewayProxyEventV2` (method, rawPath, pathParameters via the same route table, headers lower-cased, body string) and back.
  - `serverless.yml`: one HTTP function `api` (handler `src/http/handler.handler`, runtime per ADR 0001, `httpApi` catch-all `ANY /{proxy+}`), env `RIDECORE_TABLE` from the CDK output (one-way reference), IAM limited to the table and its indexes. `serverless package` succeeds without AWS credentials.
  - `npm run seed` creates 1 demo passenger token and 6 drivers around Popayán (names like "Driver 1"; no real data).
  - `make up` = compose up Floci → deploy stateful stack → seed → start local server (or Floci-deployed Lambda, per ADR 0001); `make down`.

- [ ] **Step 1: Failing e2e test** (`tests/e2e/trip-flow.test.ts`) using `fetch` against `http://localhost:3000` after `make up`: full trip via HTTP with real tokens from `signToken`, asserting final state `RATED` and that outbox items `EVENT#000001..000006` exist for the trip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement adapter, `serverless.yml`, seed, Makefile targets. **Step 4:** `make up && npx vitest run tests/e2e` → PASS. `npx serverless package` (or the fork) → exit 0, `.serverless/` contains the function zip.
- [ ] **Step 5:** Commit `feat(local): local adapter, serverless config and make up`.

---

### Task 8: CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm scripts (Task 1), `make up` pieces (Task 7).
- Produces: workflow `ci` on push and pull_request: job `checks` (Node from `.nvmrc`: `npm ci`, `lint`, `typecheck`, `test:unit`, `cdk synth`, `serverless package`); job `integration` (service container `floci/floci` on 4567; `test:integration`, then start local server and `test:e2e`); job `node24` (same unit + integration on Node 24 — Global Constraints). No secrets referenced; `RIDECORE_JWT_SECRET` set to the `.env.example` value.

- [ ] **Step 1:** Write the workflow. **Step 2:** Run it locally with `act` if available, otherwise validate with `npx action-validator .github/workflows/ci.yml` (or equivalent) → no errors. Real run happens when the owner authorizes the first push.
- [ ] **Step 3:** Commit `ci: lint, types, unit, integration, e2e and node 24 matrix`.

---

## Out of this plan (next plans)

- **Plan 2 — Events:** DynamoDB Streams outbox publisher → EventBridge; rules → SQS queues + DLQs; `trip.requested` consumer calls `offerTrip` and publishes the offer to SNS → `driver-offers` queue; idempotent consumers with version ordering; DLQ demo + redrive; e2e asserting events. Real time (spec §5b): spike Floci WebSocket support; API Gateway WebSocket API with JWT `$connect`, DynamoDB connections index, unicast per trip, throttled broadcast per geohash cell, driver offers, driver `position` messages, notifier Lambda fed by EventBridge; demo map page (Leaflet); e2e over a WebSocket client.
- **Plan 3 — MCP server:** `request_trip`, `get_trip_status`, `cancel_trip`, `list_my_trips` over the HTTP API with one passenger token.
- **Plan 4 — Docs:** README first screen, Mermaid diagram, ADRs 0002-0006, demo GIF, badges, background paragraph.
