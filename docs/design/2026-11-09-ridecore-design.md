# ridecore — design

Date: 2026-11-09 · Owner: Rodrigo Chingal · Status: draft, pending owner approval

## 1. Intent and why

`ridecore` is the backend core of a ride-hailing app (passengers request trips, drivers accept and complete them), built from scratch in 2026 as an open project to show, end to end, how we design and build an event-driven serverless backend.

Why it exists:
- We want a realistic, runnable reference for modern Node.js/AWS backend practice, small enough to read in one sitting.
- It deliberately covers what production Node.js/AWS backends need today: Node.js + TypeScript APIs, serverless on AWS (Lambda, Serverless Framework), event-driven communication (queues, pub/sub, event buses) with idempotency and retries, DynamoDB schema design, unit/integration/e2e tests, CI/CD, infrastructure as code (AWS CDK), and exposing backend services as tools for AI agents through MCP.
- The domain comes from a real platform we designed and built in 2016-2018 (a luxury ride-hailing backend in TypeScript/Express/MongoDB/socket.io). That code belongs to a former client and **must not be copied or referenced by name**. Only the domain knowledge is reused.

Success = a technical reader understands what it is, sees that it is well engineered, and can run it locally, all within ~2 minutes of opening the repo.

## 2. Goals

1. A working trip lifecycle backend: request → driver accepts → driver arrives → trip starts → trip completes → passenger rates; cancellation allowed from defined states.
2. Every state change emits a domain event; downstream consumers react asynchronously (driver dispatch notification, fare/billing record, notifications), with idempotency, retries and dead-letter queues.
3. An MCP server that lets an AI agent request a trip, check its status, cancel it, and list the passenger's trips by calling the real API.
4. Runs fully locally with one command (`make up`) against Floci (local AWS emulator), with no AWS account and no cost.
5. A README and docs that make the engineering decisions visible (see §6).
6. Green CI on every push.

## 3. Non-goals

- Mobile apps or a product frontend. The only UI is the small demo map page in §5b, used to show real-time updates.
- Real payments (fares are calculated and recorded; nothing is charged).
- Routing, turn-by-turn navigation or map tiles of our own. Positions are lat/lng values sent by drivers; distance is straight-line (haversine).
- Production-grade identity. Auth is a minimal, documented stand-in (see §7).
- Deploying to a real AWS account as part of CI. (Deploy to real AWS may be documented as optional.)
- Multi-region, high-scale load testing.

## 4. Anti-goals (would make it a failure even if it works)

- Any code, naming, branding or data from the original 2016-2018 client platform. No client names anywhere (README included).
- A tutorial-looking repo: generic scaffolding, empty folders, TODO-heavy README, untested code.
- A setup that needs an AWS account, paid services or secrets to run or to pass CI.
- Claims in the README that the code does not back up (no invented metrics or "production-ready" language).
- Over-engineering beyond what a technical reader can follow in 2 minutes.

## 5. Domain

### Trip states

`REQUESTED → ACCEPTED → DRIVER_ARRIVED → IN_PROGRESS → COMPLETED → RATED`

`CANCELLED` is reachable from `REQUESTED`, `ACCEPTED` and `DRIVER_ARRIVED` (by passenger or driver; who cancelled and why is recorded). Any other transition is rejected. The state machine is pure domain code with no AWS dependency.

### Entities

- **Passenger**: id, name, contact.
- **Driver**: id, name, vehicle (plate, model, category), availability (`OFFLINE | AVAILABLE | ON_TRIP`), last known position.
- **Trip**: id, passengerId, driverId (once accepted), service type (`STANDARD` only in v1; see behaviour rules), origin, destination, state, timestamps per transition, fare estimate, final fare, rating (1-5 + optional comment), version (for optimistic locking).

### Events (one per transition)

`trip.requested`, `trip.accepted`, `trip.driver_arrived`, `trip.started`, `trip.completed`, `trip.rated`, `trip.cancelled`. Each carries `eventId`, `tripId`, `occurredAt`, `version` and the relevant payload. Event schemas are versioned and documented.

### Behaviour rules (builder's calls after review, flagged for owner review)

- **Only `STANDARD` trips in v1** (fare by distance). `HOURLY` and `SCHEDULED` existed in the original domain but change data and behaviour (a scheduled trip needs a timer); they are deferred and listed as possible extensions in the README.
- **One active trip at a time** per passenger and per driver. Active = `REQUESTED`, `ACCEPTED`, `DRIVER_ARRIVED`, `IN_PROGRESS`. Enforced atomically: the trip write and the passenger/driver "active trip" reservation items go in the same DynamoDB transaction (`TransactWriteItems`); reservations are released in the same transaction that moves the trip to `COMPLETED` or `CANCELLED` (not at rating). A second request while one is active is rejected (409).
- **Dispatch:** candidates are `AVAILABLE` drivers in the same geohash cell (precision 5) or its neighbours, any vehicle category, up to 5 drivers. The offer is published to an SNS topic whose subscriber is an SQS "driver-offers" queue; its consumer records the offers, and the e2e test checks them. Accepting checks, in one transaction, that the driver was offered this trip, is `AVAILABLE` and has no active trip; the first driver whose transaction succeeds wins, the others get 409. This also prevents one driver accepting two trips. If nobody accepts, the trip stays `REQUESTED` indefinitely until the passenger cancels; there is no expiry timer and no re-offer (documented limitation).
- **Driver API:** go online/offline, update position, accept, arrive, start, complete, cancel.
- **Rating:** only the passenger rates, once, optionally, within 24 h of `completedAt` (server clock). History includes `COMPLETED`, `RATED` and `CANCELLED`.
- **Event delivery (transactional outbox):** each state change writes the trip and an outbox/event item in the same transaction; a publisher reading DynamoDB Streams forwards it to EventBridge, with retries. A transition can never be saved while its event is lost.
- **Idempotency, end to end:** mutating HTTP requests accept an `Idempotency-Key` header (stored with the result, replayed on retry). Consumers write the dedup record and their effect in the same transaction. Events carry the trip `version`; a consumer ignores an event older than what it already applied (out-of-order delivery).
- **Authorization per resource:** a passenger can only read, cancel and rate their own trips; a driver can only act on trips offered to or assigned to them; each transition has an allowed actor (table in the README/ADR). The MCP server acts on behalf of one passenger token and never widens it.
- **Observability:** structured JSON logs with a correlation id that flows from the HTTP request through the event and the consumers. A scripted demo shows a failing consumer → retries → DLQ → redrive.
- **CI never needs secrets.** If the spike settles on Serverless Framework v4, which needs an access key to deploy, CI does not run `sls deploy`. CI then runs the handlers through the local adapter in §8, and Floci provides the AWS services. Because the adapter proves behaviour but not that the infrastructure deploys, CI also runs `cdk synth` and `serverless package` to validate the IaC; the README says plainly which parts are verified by e2e and which only by synthesis.

## 5b. Real-time updates (added 2026-11-09, owner-approved; built in Plan 2)

The original 2016-2018 platform pushed trip updates over socket.io: separate channels for drivers and passengers, nearby cars on the passenger's map, the assigned driver's live position sent only to that passenger, and request/accept/reject round trips. A persistent socket.io server does not fit Lambda, so ridecore uses **API Gateway WebSocket APIs + Lambda**, with a DynamoDB connections index:

- **Connect** with the same JWT (passenger or driver) on `$connect`; a connection item records `connectionId`, actor, role, the current trip (if any) and, for passengers watching the map, a geohash-5 cell. `$disconnect` removes it; stale connections (`GoneException`) are deleted on send.
- **Three delivery patterns** (the old "channels"):
  1. **Unicast to a trip's participants**: trip state changes and the assigned driver's position go only to that trip's passenger (and state changes to its driver).
  2. **Broadcast by map cell**: available drivers' positions go to every passenger watching that cell or its neighbours (the "cars on the map" view), throttled (at most one update per driver every few seconds).
  3. **Unicast to a driver**: new trip offers.
- **Driver → server** messages over the socket: `position` updates (same validation and authorization as `PUT /drivers/me/position`). Accept/arrive/start/complete stay on the HTTP API (idempotent, already tested); the socket only pushes their results.
- Pushes are driven by the events of Plan 2 (EventBridge → a notifier Lambda), so the real-time layer never writes trip state.
- **Demo map page** (`demo/map.html`, static, Leaflet + OpenStreetMap tiles): shows cars moving in a cell and one trip's live driver position. Demo only, not a product frontend; it reuses dev tokens and is part of the README GIF.
- **Risk:** Floci support for API Gateway WebSocket APIs is unverified; Plan 2 starts with a spike. Fallback if Floci lacks it: run the WebSocket handlers behind a thin local `ws` adapter (as the HTTP local adapter does) and keep the Serverless config valid for real AWS, documented in an ADR.

## 6. What a reader must see in the first 2 minutes

1. **README first screen**: one-sentence description; architecture diagram (Mermaid); "run it" in one command; CI and coverage badges.
2. **Quality signals without opening code**: green CI badge, coverage, and `docs/decisions/` with 4-6 short ADRs (why DynamoDB single-table, why EventBridge + SQS, idempotency strategy, optimistic locking, why Serverless Framework + CDK split, MCP design).
3. **Proof it works**: a short GIF or a copy-paste `curl` walkthrough of a full trip, plus an example of an agent requesting a trip through MCP.
4. A one-paragraph "Background" noting it is inspired by a ride-hailing platform the author designed in 2016-2018, without naming the client.

## 7. Decided "how" (owner-approved)

- **Runtime**: Node.js 26 LTS (26.13.0 or newer, the current LTS line since 2026-10-28; owner requirement after the October 2026 security releases). On Lambda: `nodejs26.x` (public preview as of 2026-11; GA expected now that 26 is Active LTS). The README states this.
- **Language**: TypeScript in strict mode.
- **Compute**: AWS Lambda behind API Gateway (HTTP API), defined with **Serverless Framework** (widely used for Lambda services).
- **Data**: **DynamoDB**, schema designed from access patterns (single-table unless an ADR justifies otherwise). Required access patterns: trip by id; active trip of a passenger; active trip of a driver; trip history of a passenger (newest first); available drivers in an area (coarse geohash prefix is acceptable).
- **Events**: state changes published to an **EventBridge** bus; rules route events to **SQS** queues per consumer, each with a **DLQ**; **SNS** used for fan-out notification (e.g. offering a requested trip to candidate drivers). Consumers are idempotent (event id dedup with conditional writes). Trip writes use optimistic locking (version attribute, conditional update).
- **Infrastructure as code**: **AWS CDK** (TypeScript) is also used. Builder's call, flagged for owner review: CDK owns the stateful, long-lived resources (DynamoDB table, EventBridge bus, SNS topic, SQS queues + DLQs); Serverless Framework owns the functions and their HTTP/queue triggers, referencing CDK outputs. This "stateful vs stateless stacks" split must be explained in an ADR. Every resource (including rules, permissions and subscriptions) has exactly one owner, and references go one way only (Serverless reads CDK outputs, never the reverse) to avoid circular dependencies.
- **AWS SDK** v3 in code.
- **Tests**: unit (domain/state machine, fare calculation, handlers with fakes), integration (repositories and event publishing against Floci), e2e (full trip through the HTTP API on Floci, asserting the events consumed).
- **CI**: GitHub Actions running lint, typecheck, unit, integration and e2e (Floci as a service container). Badges in the README.
- **MCP server**: TypeScript, official MCP SDK, stdio transport. Tools: `request_trip`, `get_trip_status`, `cancel_trip`, `list_my_trips`. It calls the HTTP API (not the database directly). Tool inputs are validated; errors are returned as readable tool errors.
- **Local**: Floci (local AWS emulator, MIT, no account; already used in the owner's lab) via Docker Compose; `make up` brings everything up and seeds demo data; `make demo` runs the scripted trip.
- **Auth stand-in**: requests carry a bearer token identifying a passenger or driver; tokens are minted by a local dev script and verified by the API. Documented as a placeholder for a real identity provider.
- **Repo**: `github.com/Chingal/ridecore`, created **private**; made public only with the owner's explicit approval. Code, docs and commits in English. Commits without `Co-Authored-By` lines.
- **Build process**: spec-first; built with Codex as co-worker and reviewer. No push to GitHub without the owner's order.

## 8. Constraints and risks

- **Floci coverage is unverified for Lambda and for `nodejs26.x`** (the owner's lab verified DynamoDB, SQS, SNS, Secrets; Lambda was not tested). The first step of the plan must be a short spike proving: (a) Node 26 Lambda runs in Floci, (b) Serverless Framework can deploy to Floci, (c) CDK can deploy to Floci, (d) EventBridge → SQS routing works in Floci. The spike also checks (e) DynamoDB Streams → Lambda in Floci (needed by the outbox). If (a) or (b) fails, fallback: run the same handlers through a thin local HTTP/queue adapter for local and CI, keeping the Serverless config valid for real AWS. Any fallback is recorded in an ADR and in the README.
- **If any tool rejects `nodejs26.x`** (Lambda preview, Serverless, CDK): keep Node 26 for development, tests and CI, deploy Lambda as `nodejs24.x` until `nodejs26.x` is GA, keep the code compatible with Node 24 and run the test suite on Node 24 too; documented in the README and an ADR. A Node 26 container image is the rejected alternative (extra runtime maintenance). *Confirmed by the owner 2026-11-09.* Rationale: the October 2026 security fixes shipped for every supported line (26.12.1, 24.22.1, 22.23.4), so what matters is running a patched release; Node 26.13.0+ is the minimum for development and CI.
- **Serverless Framework v4** requires logging into a Serverless account even for free use. The owner creates any account himself; if that is unacceptable, use the open-source v3-compatible fork and record it in an ADR. (Spike decides.)
- Laptop resources are modest; the local stack should stay light.

## 9. Build order

0. Compatibility spike (§8).
1. Core: domain and state machine, DynamoDB repository with transactions and outbox items, HTTP API, auth and authorization, idempotency keys, unit + integration tests, CI. Event contracts are defined here even if delivery comes later.
2. Events and real time: outbox publisher, EventBridge rules, SQS consumers, SNS dispatch, DLQs, DLQ demo; WebSocket API (connect/auth, unicast per trip, broadcast per map cell, driver offers, driver position messages) and the demo map page; e2e tests for events and pushes.
3. MCP server.
4. README, ADRs, demo GIF. *(Order pending owner confirmation.)*

## 10. Left to the builder

Folder layout (monorepo or not), test runner, lint config, fare formula, exact DynamoDB key design, event schema format, Mermaid diagram style, number of seed drivers/passengers, GIF vs asciinema, license choice (MIT suggested).
