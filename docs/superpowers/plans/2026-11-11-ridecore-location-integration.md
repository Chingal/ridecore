# ridecore ↔ ridecore-location integration and measurement — Plan 7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ridecore uses `ridecore-location` when `RIDECORE_LOCATION_URL` is set, `make load` can run on both paths, and the same `peak` profile is measured before and after.

**Architecture:** One switch. Unset, ridecore behaves exactly as today. Set, dispatch asks the location service for the nearest 50 fresh drivers and keeps those still `AVAILABLE` in DynamoDB (one batch read); driver positions go to the location service, not to DynamoDB. Trip assignments reach the location service through a new EventBridge rule and SQS queue in the CDK stack.

**Tech Stack:** Node 26 + TypeScript (existing), AWS CDK (existing), k6 `grafana/k6:2.3.0` (existing), the Go service from Plan 6.

**Spec:** `docs/superpowers/specs/2026-11-11-ridecore-location-design.md`. Depends on Plan 6 (the service and its contracts in `ridecore-location/docs/contracts.md`) and on Plan 5 (merged: `make load`, the checker, `docs/load-results/2026-11-11`).

## Global Constraints

- With `RIDECORE_LOCATION_URL` unset: no behaviour change; `make test`, `npm run test:integration`, `make e2e`, `make demo` and CI stay green without the Go service running.
- Over-fetch **50** from the location service; offer to the nearest **5** (`OFFER_FANOUT`), at most `MAX_OFFERS_PER_TRIP` in total — unchanged.
- `finishTrip`, `setAvailability` and the `AVAIL#cell` index code are not changed (spec §7.2).
- The location key `RIDECORE_LOCATION_KEY` (≥ 32 chars) and the JWT secret come from the env policy (`scripts/load-env.ts`); never printed, never committed outside `.env.example` dev values.
- No client or employer names; commits without `Co-Authored-By`; no push without the owner's order.
- Numbers are Floci-on-a-laptop numbers and are labelled so.

## Review Focus

1. **Location service down or slow during dispatch** — the `trip.requested` message must fail and retry (SQS redelivery), not record "no driver near"; the HTTP call times out at 2 s. Test in Task 2.
2. **A driver the location service returns who is ON_TRIP or OFFLINE in DynamoDB** — never offered. Test in Task 2.
3. **More than 100 ids in one batch read** (DynamoDB's `BatchGetItem` limit) and `UnprocessedKeys` — 50 is under the limit, but unprocessed keys must be retried. Test in Task 2.
4. **The switch set but empty (`RIDECORE_LOCATION_URL=`)** — treated as unset, not as a URL. Test in Task 3.
5. **Load run in Go mode while the Go stack is not up** — `make load LOCATION=1` stops early with "run 'make up LOCATION=1'", before creating actors. Test in Task 4.

---

### Task 1: EventBridge rule and queue for the location service

**Files:** Modify `infra/cdk/stateful-stack.ts`, `infra/cdk/stateful-stack.test.ts`, `src/events/names.ts`, `scripts/cdk-env.ts`.

**Interfaces:**
- Produces: `LOCATION_TRIPS_QUEUE_NAME = 'ridecore-location-trips'` in `names.ts`; a `consumerQueue('LocationTrips', LOCATION_TRIPS_QUEUE_NAME)` (same DLQ policy as the others); a rule `TripAssignmentsToLocation` with `detailType: ['trip.accepted','trip.completed','trip.cancelled']`; outputs `LocationTripsQueueUrl` / `LocationTripsQueueArn` (from the helper), exported by `cdk-env.ts` as `RIDECORE_LOCATION_TRIPS_QUEUE_URL`.
- [ ] **Step 1: Failing test** in `stateful-stack.test.ts`: a rule targets the `ridecore-location-trips` queue with exactly those three detail types; the queue has a redrive policy to `ridecore-location-trips-dlq`.
- [ ] **Step 2:** `npx vitest run --project unit infra` → FAIL. **Step 3:** Implement. **Step 4:** → PASS; `make deploy-stateful` on Floci → the queue exists (`aws sqs get-queue-url` via the Floci env or a Node script).
- [ ] **Step 5: Commit** `feat(cdk): trip assignments queue for ridecore-location`.

### Task 2: Location client and the nearby source for dispatch

**Files:** Create `src/infra/location/client.ts`, `tests/unit/infra/location-client.test.ts`, `tests/unit/app/dispatch-location.test.ts`; modify `src/app/dispatch.ts`, `src/infra/dynamo/driver-repo.ts`, `tests/integration/…driver-repo…` (the existing driver repo integration test file).

**Interfaces:**
- Produces:
  - `export const LOCATION_OVERFETCH = 50;`
  - `export interface NearbySource { availableNear(p: LatLng, limit: number): Promise<{ id: string }[]> }` in `dispatch.ts`; `createDispatch(deps: { trips; drivers; nearby?: NearbySource })` — default `nearby` is `deps.drivers` (today's behaviour).
  - `DriverRepo.availabilityOf(ids: readonly string[]): Promise<Map<string, Availability>>` — `BatchGetItem` with consistent reads, chunks of 100, retries `UnprocessedKeys` up to 5 times with backoff, then throws `DomainError('SERVICE_UNAVAILABLE', 503, …)`.
  - `createLocationClient(opts: { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number /* 2000 */ }): { nearby(p: LatLng, limit: number): Promise<string[]> }` — `GET {url}/v1/nearby?lat&lng&limit` with `Authorization: Bearer {key}`; non-200, timeout, bad JSON or `schemaVersion !== 1` → `DomainError('LOCATION_UNAVAILABLE', 503, …)`.
  - `createLocationNearby(client, drivers: Pick<DriverRepo,'availabilityOf'>): NearbySource` — asks for `LOCATION_OVERFETCH`, keeps ids whose availability is `AVAILABLE`, keeps the location service's order, returns the first `limit`.
- [ ] **Step 1: Failing tests:** client: sends key and query, parses ids in order; 500 → LOCATION_UNAVAILABLE; hanging fetch → LOCATION_UNAVAILABLE within 2.5 s; `schemaVersion: 2` → LOCATION_UNAVAILABLE. Nearby source: location returns `[d1 ON_TRIP, d2 AVAILABLE, d3 OFFLINE, d4 AVAILABLE]`, limit 5 → `[d2, d4]` — **Review Focus 2**; asks the client for 50 whatever `limit` is. Dispatch: `offerTripOnce` with a nearby source that throws → the error propagates (the consumer's batch failure makes SQS retry) and no offer is written — **Review Focus 1**. Integration (Floci table): `availabilityOf` with 120 ids (some missing) → a map of the existing ones — **Review Focus 3**.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `offerTrip` and `offerTripOnce` call `nearby.availableNear` where they call `drivers.availableNear` today. **Step 4:** `make test` and `npm run test:integration` → PASS.
- [ ] **Step 5: Commit** `feat(dispatch): nearby drivers from ridecore-location behind a source interface`.

### Task 3: The switch, wired everywhere dispatch is built

**Files:** Modify `src/http/deps.ts`, `src/events/consumers/dispatch.ts`, `src/realtime/ws.ts`, `scripts/load/actors.ts`, `serverless.yml`, `.env.example`; create `tests/unit/http/location-switch.test.ts`.

**Interfaces:**
- Produces: `locationFromEnv(env = process.env): { url: string; key: string } | null` in `deps.ts` — `RIDECORE_LOCATION_URL` empty or unset → `null` (**Review Focus 4**); set → requires `RIDECORE_LOCATION_KEY` ≥ 32 chars, else throws naming the variable. `DepsOptions.location?: { url; key } | null`; `createDeps` builds `createDispatch({ trips, drivers, nearby })` with the location source when given. The dispatch consumer and `ws.ts` use `locationFromEnv()` the same way.
- `serverless.yml`: `RIDECORE_LOCATION_URL: ${env:RIDECORE_LOCATION_URL, ''}` and `RIDECORE_LOCATION_KEY: ${env:RIDECORE_LOCATION_KEY, ''}` in `provider.environment`. For Floci Lambdas the URL is the one found in Plan 6 Task 0, set in `.env.local` by `make up LOCATION=1` (Task 4).
- `.env.example`: both variables commented out, with a dev key of 32+ characters marked as dev-only.
- [ ] **Step 1: Failing tests:** `locationFromEnv({})` → null; `{RIDECORE_LOCATION_URL:''}` → null; URL without key → throws mentioning `RIDECORE_LOCATION_KEY` and not the key value; short key → throws; valid → `{url,key}`. `createDeps` with `location` → `dispatch.offerTrip` calls the fake location fetch.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `make test` → PASS; `make package` still works with the variables unset.
- [ ] **Step 5: Commit** `feat: RIDECORE_LOCATION_URL switch for dispatch`.

### Task 4: One command up, and `make load` on both paths

**Files:** Modify `Makefile`, `scripts/load/run.ts`, `scripts/load/actors.ts`, `load/lib.js`, `load/rush-hour.js`, `docs/load-testing.md`; create `tests/unit/scripts/load-run-location.test.ts`.

**Interfaces:**
- Makefile: `LOCATION_DIR ?= ../ridecore-location`; `up` with `LOCATION=1` also runs `$(MAKE) -C $(LOCATION_DIR) up` and starts the service in the background (`run-bg`, pid file `.load/location.pid`, logs `.load/location.log`), waits for `/healthz` 200 (30 s), and writes `RIDECORE_LOCATION_URL`, `RIDECORE_LOCATION_KEY`, `RIDECORE_LOCATION_WS_URL` to `.env.local` only if absent (never overwrites the owner's values); `down` stops it. `load PROFILE=… LOCATION=1` passes `-e LOC_WS=$RIDECORE_LOCATION_WS_URL` to k6.
- `run.ts`: with `LOCATION=1`, before setup, `GET $RIDECORE_LOCATION_URL/healthz` must answer 200 within 5 s, else exit 1 with `ridecore-location is not reachable: run 'make up LOCATION=1'` — **Review Focus 5**; the k6 container must reach the location WS (same network answer as Plan 6 Task 0).
- `actors.ts`: in Go mode, setup sets drivers `AVAILABLE` without writing positions to DynamoDB if `setAvailability` allows it; if it requires a position, keep that single write and say so in `docs/load-testing.md`.
- k6: when `LOC_WS` is set, each driver opens **two** sockets: ridecore's (offers and trips, as today, no `position` messages) and the location driver socket (`/v1/drivers/ws`, a position every 3 s). Watchers connect to `/v1/map/ws` and count `cars` messages in the existing map-messages metric. Riders unchanged. Same profiles, same thresholds, same checker.
- [ ] **Step 1: Failing test:** the run script's preflight (exported as a function) returns the "not reachable" error when `/healthz` refuses or answers 503, and is skipped when `LOCATION` is unset.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `make test` → PASS; `make up LOCATION=1 && make load PROFILE=smoke LOCATION=1` → checker clean, every trip offered.
- [ ] **Step 5: Commit** `feat(load): run the rush hour against ridecore-location`.

### Task 5: End-to-end in Go mode

**Files:** Create `tests/e2e/location.test.ts`.
- Skipped (`describe.skipIf`) unless `RIDECORE_LOCATION_URL` is set, so the default e2e run is unchanged.
- [ ] **Step 1: Test** `driver position via location → passenger request → driver gets the offer → accept → passenger's map socket gets driver_position → complete → driver visible again in /v1/nearby` (tokens from `signToken` with the dev secret; ids prefixed `e2e-loc-`; teardown sets the driver OFFLINE).
- [ ] **Step 2:** Run with the Go stack down and the variable set → FAIL (connection refused). **Step 3:** `make up LOCATION=1`, run `make e2e` → PASS; run with the variable unset → the file is skipped and the rest passes.
- [ ] **Step 4: Commit** `test(e2e): trip flow with ridecore-location`.

### Task 6: Measure before and after, and write it down

**Files:** Create `docs/load-results/<run date>-location/{ratios.txt,location-stats.txt}`; modify `docs/adr/0008-*.md` (results section), `docs/load-testing.md`, `README.md` ("Scaling track" section with the link to `ridecore-location`, private until the owner says otherwise — link text only, no claim it is public).
- [ ] **Step 1:** "Before": reuse `docs/load-results/2026-11-11` (same profile, same machine); rerun only if `make load PROFILE=peak` without `LOCATION` gives numbers more than 10 points away from it, and say which was used.
- [ ] **Step 2:** "After": `make up LOCATION=1 && make load PROFILE=peak LOCATION=1`, then `scripts/load/ratios.ts` → `ratios.txt`; the Go service's counters (positions accepted / rate-limited / published, Kafka produce errors, map messages sent / dropped) from its log → `location-stats.txt`.
- [ ] **Step 3:** Expected (spec success 1): every trip offered, every finished trip billed, checker clean. If not, record the numbers as they are, find the cause (systematic-debugging), and do not adjust the profile to make it pass.
- [ ] **Step 4:** ADR 0008: a before/after table, what changed and why, what is still a hypothesis on AWS, the next step of the track (batch matching).
- [ ] **Step 5: Commit** `docs: before and after ridecore-location under the peak profile`.
