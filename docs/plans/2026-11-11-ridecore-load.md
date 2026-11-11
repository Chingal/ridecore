# Local Load Testing Implementation Plan

**Goal:** Simulate a rush hour against the local Floci stack (many drivers moving, many passengers watching the map and requesting trips), check that the system stays **correct** under that load, find where it breaks, and write down what it means for real scale. Local and free: no AWS account, nothing deployed outside the laptop.

**Architecture:** k6 (run from its official Docker image, pinned) drives HTTP and WebSocket traffic from a set of load actors created by a setup script. After each run, an invariant checker reads the table and the queues and reports anything inconsistent (stuck reservations, trips without billing, messages in DLQs). The results and the scaling analysis become `docs/load-testing.md` and ADR 0008.

**Tech Stack:** k6 `2.3.0` (`grafana/k6:2.3.0`, Docker), Node 26 TypeScript scripts with the AWS SDK v3 already in the repo, Vitest.

**Spec:** `docs/design/2026-11-09-ridecore-design.md`. The spec leaves high-scale load testing out of scope (§3: "Multi-region, high-scale load testing"). This plan stays inside that: it tests behaviour under concurrency on a laptop, not AWS capacity. The owner asked for it on 2026-11-11, limited to the local and free part.

## Global Constraints

- Local and free only. Floci on `localhost:4567`, no AWS account, no paid services. Docker pulls `grafana/k6:2.3.0` once; nothing else is downloaded.
- Floci is an emulator in one container on a laptop with 8 cores and ~7 GB free. Every number this plan records is labelled "Floci on a laptop", and none is presented as AWS capacity. That would break the spec's "no invented metrics" anti-goal.
- Load actors use their own ids (`load-driver-<n>`, `load-passenger-<n>`) and their own area. Seed, demo and e2e data are never touched.
- Tokens live only in a git-ignored file (`.load/actors.json`) and in memory. They are never printed or committed.
- Defaults stay small enough for the laptop: the smoke profile runs in under 1 minute, and the peak profile runs with 100 drivers and 200 passengers.
- Code, docs and commits in English; commits without `Co-Authored-By`; no push without the owner's order.

## Review Focus

1. **The laptop or Floci falls over before the system under test does.** A run must stop cleanly: k6 thresholds abort it, and teardown still runs. A Floci crash must be reported as such, never as a ridecore result. Pinned in Task 4 (teardown in `make load`, even on failure) and Task 5 (the report names the limiting resource).
2. **Load actors leaking into other data.** A crashed run can leave drivers AVAILABLE near the demo centre and steal the five offer slots (deferred minor from Plan 4). The actors' area must be away from `DEMO_CENTRE`, and teardown must be idempotent and runnable on its own. Pinned in Task 1.
3. **The invariant checker reports "clean" when it read nothing.** It must count what it read: trips, drivers, queues. A run with zero trips read is a failure, not a pass. Pinned in Task 3.
4. **A crowded map cell.** `ConnectionRepo.watchersOf` throws past `MAX_QUERY_ITEMS` (500). The peak profile puts more than 500 watchers in one cell on purpose, in a separate `crowded` profile, to show what happens: the positions mapping retries and then drops the record. That outcome is recorded, not hidden. Pinned in Task 2 (profile) and Task 5 (finding).
5. **Results that cannot be reproduced.** Each recorded run notes the profile, the commit, the k6 version, the Floci version and the machine. Pinned in Task 5.

---

### Task 0: Spike — k6 against Floci from Docker

**Files:**
- Create: `load/spike.js` (deleted after the spike), and a "k6 spike" section in `docs/load-testing.md`

Check, with `docker run --rm --network host -v "$PWD/load:/load" grafana/k6:2.3.0 run /load/spike.js`:
- (a) an HTTP call to `RIDECORE_API_URL` with a bearer token returns 200;
- (b) the `k6/websockets` module opens `RIDECORE_WS_URL` with the subprotocols `['ridecore.v1', <token>]`, which `$connect` accepts;
- (c) a `watch` message gets `car` messages back;
- (d) the host name `*.execute-api.localhost.floci.io` resolves inside the container under `--network host`.

- [ ] **Step 1:** Write the spike, run it, and record the results as a table, the same way ADR 0005's spike was recorded.
- [ ] **Step 2:** If (b) fails because k6 cannot send subprotocols, rule on a fallback: a Node 26 WebSocket load client (`scripts/load/ws-client.ts`) that k6 does not replace, while k6 keeps the HTTP traffic. Record the ruling and continue.
- [ ] **Step 3:** Commit `docs: k6 against Floci spike` (spike file removed).

### Task 1: Load actors — setup and teardown

**Files:**
- Create: `scripts/load/actors.ts`, `tests/unit/scripts/load-actors.test.ts`
- Modify: `.gitignore` (`.load/`)

**Interfaces:**
- Produces:
  - `LOAD_CENTRE: LatLng = { lat: 2.45, lng: -76.47 }` (cell `d23tg`, east of Popayán). Its cell and 8 neighbours share no cell with `DEMO_CENTRE`'s 3 × 3 block (checked with ngeohash), so dispatch for a demo, seed or e2e trip never sees a load driver, and the reverse holds too. The test asserts it.
  - `planActors(drivers: number, passengers: number, seed: number): { drivers: LoadDriver[]; passengers: LoadPassenger[] }`: deterministic positions within ~1.5 km of `LOAD_CENTRE`, ids `load-driver-<n>` / `load-passenger-<n>`.
  - `setupActors(opts) / teardownActors(opts)`: setup upserts the drivers (through `createDeps`, like `scripts/seed.ts`), sets them AVAILABLE at their position, and writes `.load/actors.json` (ids, roles, tokens, positions). Teardown cancels every active trip of a load passenger, completes any `IN_PROGRESS` one as its driver, and sets load drivers OFFLINE. It is safe to run twice, and safe to run without `.load/actors.json`: it then finds the actors by their id prefix.

- [ ] **Step 1: Failing tests.**
  - `planActors` is deterministic for a seed.
  - Every position is within 1.5 km of `LOAD_CENTRE`.
  - The 3 × 3 block of `cellOf(LOAD_CENTRE)` shares no cell with the 3 × 3 block of `cellOf(DEMO_CENTRE)`, and every planned actor's cell is inside the load block.
  - Teardown with fakes cancels REQUESTED/ACCEPTED/DRIVER_ARRIVED trips and completes IN_PROGRESS ones.
  - A second teardown does nothing.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS; `make test` green.
- [ ] **Step 5:** `node --import ./scripts/load-env.ts scripts/load/actors.ts setup 20 40`, then `… teardown` twice → both exit 0, and `make demo` still gets an offer from a seeded driver.
- [ ] **Step 6:** Commit `feat(load): load actors, setup and teardown`.

### Task 2: k6 scenarios and profiles

**Files:**
- Create: `load/rush-hour.js`, `load/lib.js`

Three k6 scenarios that run together. Each one reads `.load/actors.json`, mounted into the container:

| Scenario | Actors | Behaviour |
|---|---|---|
| `drivers` | every load driver | opens a WebSocket and sends `position` every 3 s (a small random walk); answers an `offer` push by accepting over HTTP, then arrive, start and complete with 2-5 s pauses |
| `watchers` | ~half the passengers | opens a WebSocket, sends `watch` at its own position, then stays connected and counts `car` messages |
| `riders` | the other half | requests a trip with an `Idempotency-Key`, polls `GET /trips/{id}` until it is ACCEPTED or 60 s pass, then either lets it finish or cancels it (20%) |

Custom metrics:
- `time_to_offer`: from the request to the offer being pushed to a driver.
- `time_to_accept`.
- `map_messages`.
- `conflicts_409`, counted by code (`TRIP_ALREADY_TAKEN`, `CONCURRENT_UPDATE`, `ACTIVE_TRIP_EXISTS`).
- `ws_refused`.

Profiles, chosen with `PROFILE`:

| Profile | Drivers | Passengers | Shape | Duration |
|---|---|---|---|---|
| `smoke` | 5 | 10 | constant | 45 s |
| `peak` | 100 | 200 | ramp 0 → full over 2 min, hold 3 min | 5 min |
| `spike` | 100 | 200 | quiet 1 min, then ×10 riders in 20 s | 3 min |
| `crowded` | 20 | 600 watchers in one cell | constant | 2 min |

Thresholds abort the run if `http_req_failed` > 5 % or `ws_refused` > 5 %. The `crowded` profile only reports, since it is expected to break.

- [ ] **Step 1:** Write the scenarios. **Step 2:** `PROFILE=smoke` → it completes, at least one trip reaches COMPLETED, and `time_to_offer` has samples. **Step 3:** Commit `feat(load): k6 rush-hour scenarios and profiles`.

### Task 3: Invariant checker

**Files:**
- Create: `scripts/load/check.ts`, `tests/unit/scripts/load-check.test.ts`, `tests/integration/load-check.test.ts`

**Interfaces:**
- Produces: `checkInvariants(deps): Promise<{ read: { trips: number; drivers: number; queues: number }; violations: string[] }>`, and a CLI that prints both and exits 1 if there is a violation or `read.trips === 0`.

Invariants, for load actors only:
1. Every reservation `PASSENGER#…/ACTIVE` and `DRIVER#…/ACTIVE` points to a trip in an active state, and every active trip has its reservations.
2. Every COMPLETED or RATED trip has a `BILLING` record, after the queues drain (wait up to 60 s).
3. No load driver is ON_TRIP without an active trip.
4. Each trip's outbox events have versions 1..N with no gaps.
5. Every DLQ is empty. The dispatch, billing, driver-offers and notifications queues are drained (0 visible and 0 in flight) after the wait.

- [ ] **Step 1: Failing unit tests.** Use fakes with one violation per invariant, each named in the output. A run that reads 0 trips fails.
- [ ] **Step 2: Failing integration test.** Against Floci: write an orphan reservation for a test id; the checker reports it; clean up.
- [ ] **Step 3:** Implement. **Step 4:** All pass; `make test` and `npm run test:integration` green.
- [ ] **Step 5:** Commit `feat(load): invariant checker for after a load run`.

### Task 4: Make targets

**Files:**
- Modify: `Makefile` (`.PHONY`, plus targets `load` and `load-teardown`)

- `make load PROFILE=smoke|peak|spike|crowded`: requires `.env.deploy`. It runs setup with the profile's actor counts, then `docker run --rm --network host` k6 with the profile, then the checker, and **always** teardown, even when k6 or the checker fail. It exits with the first failure.
- `make load-teardown`: teardown on its own, for after a crash.
- The k6 summary goes to `.load/<profile>-<timestamp>.json`, which is git-ignored.

- [ ] **Step 1:** Write the targets. **Step 2:** Run `make load PROFILE=smoke` → exit 0, checker clean with `read.trips > 0`. Then run `make load PROFILE=smoke` with Floci stopped halfway (`docker pause ridecore-floci-1` for 20 s, then unpause) → it fails, teardown still runs, and the message names Floci. **Step 3:** Commit `feat(load): make load and make load-teardown`.

### Task 5: Runs, findings and ADR 0008

**Files:**
- Create: `docs/load-testing.md`, `docs/decisions/0008-scaling.md`
- Modify: `README.md` ("Tests and CI" row and "Decisions" entry)

- [ ] **Step 1:** Run `peak`, `spike` and `crowded` once each, from a fresh `make up`. For each, record:
  - the k6 summary: requests, p50/p95/p99 latency, `time_to_offer` p95, the 409s by code, `map_messages`;
  - the checker output;
  - Floci's CPU and memory (`docker stats --no-stream` sampled every 10 s);
  - the commit, the k6, Floci and Node versions, and the machine.
- [ ] **Step 2:** Write `docs/load-testing.md`: how to run it, what each profile models, the recorded results, what broke first and why. The header says: "Floci on a laptop: these numbers show behaviour under concurrency, not AWS capacity."
- [ ] **Step 3:** Write ADR 0008 (scaling):
  - the bottlenecks, each backed by a finding from Step 1 or by the code:
    - the map fan-out cost (drivers × watchers);
    - one DynamoDB write per position;
    - hot geohash-5 partitions;
    - the `watchersOf` cap;
    - shared Lambda concurrency;
    - no re-offer;
  - then the improvements in order of cost:
    - reserved concurrency per function;
    - per-user socket and watch limits;
    - one map message per cell per second;
    - skipping unchanged positions;
    - finer cells downtown;
    - positions out of DynamoDB (Redis GEO or Kinesis);
    - managed topic fan-out (IoT Core MQTT or AppSync Events);
    - re-offer with a growing radius;
    - batch matching;
    - surge pricing or bidding;
  - and what a real-AWS test would add. That test is not done, and it would need the owner's approval and a cost estimate.
- [ ] **Step 4:** Add the README row and the Decisions entry. Every number must come from Step 1.
- [ ] **Step 5:** Commit `docs: local load results and ADR 0008 on scaling`.
