# ridecore-location — design

Date: 2026-11-11. Owner-approved in conversation; this document is the written form.

## 1. Intent and why

ridecore (Node.js + TypeScript on AWS serverless) has a measured bottleneck. Under a local rush hour (`make load PROFILE=peak`, ADR 0008), driver positions are writes to the trip table, so they fill its stream. Trip events wait behind them: on Floci they were dropped, and only 23 % of trips got an offer. On AWS they would be delayed, which is a hypothesis.

`ridecore-location` is a **new repository, in Go**, that takes the hot path out of ridecore:
- driver positions;
- "who is near this point?";
- the live map.

It is the first step of a **scaling track**: a sequence of repositories that show how this system grows from thousands to millions of users, one measured decision at a time.

**Why it exists, in the owner's words:** to gain the capability to *make and explain architecture decisions for scale*, for interviews with companies that have these problems ("how do we scale this from thousands to millions?"). The language matters less than the decisions. Go is chosen because it fits this part of the system, and because the owner wants to learn and show it.

**Success:**
1. With the Go path on, the same `make load PROFILE=peak` gives **every trip an offer and every finished trip its billing record**. The invariant checker is clean, and the numbers before and after are recorded.
2. Every decision is in an ADR, including the alternatives that were **rejected**, with what each choice costs and when it would change.
3. The owner can explain each part. `docs/learning-notes.md` gives, for each part, the Go concept, an interview question it raises and how to answer it.

## 2. Goals

1. **Position ingest.**
   - Drivers connect to `ridecore-location` over WebSocket with their ridecore JWT, and send a position every 3 s.
   - The current position is kept in **Redis** with a geo index.
   - Every position is appended to **Kafka**, partitioned by geohash-5 cell.
2. **Nearby query.** Over HTTP, given a point and a limit, it returns the nearest drivers with a fresh position (seen within 30 s), nearest first. ridecore's dispatch uses it.
3. **Live map, fed by Kafka.**
   - Passengers connect with their JWT and `watch` a point.
   - They get **one message per cell per second** with the cars in the 3 × 3 cells around them: driver id and position, nothing personal.
   - The map broadcaster is a **Kafka consumer** in its own consumer group. It reads the position topic, keeps the latest position per driver per cell in memory, and sends each cell's batch once a second. It does not read Redis on every tick. Redis stays for the nearby query.
   - A car that stops reporting drops out after 30 s. Because positions are keyed by cell, a driver's updates can arrive out of order when they cross a cell border; the broadcaster keeps the one with the newest timestamp.
   - **Why Kafka and not Redis for the map:** with more traffic, more broadcaster instances join the group and Kafka spreads the partitions (cells) among them. This is how the map scales, and it is the part of the track that teaches partitions, consumer groups, offsets and rebalancing. The cost is a few milliseconds of extra delay on the map, which a map tolerates.
   - **Limit stated, not hidden:** with one instance, which is the local setup, every cell is in the same process. With several instances, a watcher connected to instance A may watch a cell whose partition belongs to instance B. The scaling ADR compares the two answers (route each watcher to the instance that owns its cells, or let each instance read the partitions its own watchers need, outside a group) and picks one. Locally, only one instance runs.
4. **Driver position during a trip.** That trip's passenger gets the assigned driver's position. Trip assignments are learned from ridecore's own events: `trip.accepted` sets one, and the trip's end (`trip.completed`, `trip.cancelled`) clears it. The events arrive on an SQS queue fed by an EventBridge rule in ridecore's CDK stack, so the location service never calls ridecore to ask.
5. **ridecore changes** (Node), behind one setting:
   - With `RIDECORE_LOCATION_URL` **unset**, ridecore behaves exactly as today. This keeps the "before" measurement and the current e2e tests.
   - With it **set**, dispatch asks the location service for nearby drivers and then keeps only those still `AVAILABLE` in DynamoDB (one batch read). Driver positions no longer go to DynamoDB, and the positions Lambda gets nothing to do.
6. **Load test on both paths.** `make load` gains a switch so the k6 drivers and watchers talk to the location service, and both paths run with the same profiles and the same invariant checker.
7. **One command** brings up everything locally: Floci with ridecore, plus Redis, Kafka and the Go service.
8. **CI for the new repository:**
   - `go vet`, `golangci-lint` (with gosec), `govulncheck`;
   - unit tests;
   - integration tests with real Redis and Kafka, in containers.

## 3. Non-goals

- Batch matching, splitting by city or region, and a WebSocket gateway for trips. These are the next repositories of the track, written down in the scaling ADR but not built.
- Deploying to AWS. The AWS shape (ECS or Fargate, ElastiCache, MSK or Kinesis, an ALB with WebSockets) is described in an ADR, but nothing is created and nothing is paid for.
- Replacing ridecore's trip API, events or MCP server. They stay in Node.
- Production identity. The location service verifies the same HS256 dev JWT as ridecore, with a shared secret. An ADR states that production would use asymmetric keys (JWKS), so the location service could verify tokens but never mint them.

## 4. Anti-goals

- Any client or employer name, any mention of employment, any copied code. These are the same rules as ridecore.
- Numbers that were not measured, or Floci and laptop numbers presented as AWS capacity.
- Technology added to show it off. RabbitMQ, Erlang/Elixir and Rust are **not** used; an ADR says why, and when each one would be the right call.
- A framework where the standard library does the job (see §5). The owner asked specifically that security not be weakened by that choice.
- Breaking ridecore's current behaviour, tests or demo when the location service is off.

## 5. Decided "how"

- **Go,** the current stable release (1.27 on the owner's machine), using the standard library's `net/http` with method-and-path routing. **No web framework.**
  - Gin and Echo are rejected in an ADR: Go's routing has covered what they were mainly used for since 1.22.
  - Fiber is rejected: it is built on `fasthttp`, so it is not `net/http`-compatible.
- **Security is explicit,** each item with a test where it can be tested:
  - server read-header, read, write and idle timeouts;
  - a maximum message and body size;
  - JWT verification with the algorithm pinned to HS256 and expiry required, rejecting `alg: none`, the same rules as ridecore's `jose` code;
  - rate limiting per connection and per IP for `watch` and positions;
  - one connection per driver;
  - a maximum number of sockets per passenger;
  - panic recovery;
  - input validation: lat/lng ranges and message shape;
  - no token in logs;
  - `govulncheck` and gosec in CI.
- **Libraries:** small and well maintained, with exact versions checked when the plan is written.
  - `redis/go-redis` v9;
  - a Kafka client: `twmb/franz-go` preferred, otherwise `segmentio/kafka-go`;
  - `coder/websocket`;
  - `log/slog`;
  - the AWS SDK for Go v2, for the SQS queue of trip events;
  - `testcontainers-go` for integration tests.
- **Data:**
  - Redis holds only current state: the geo set per area, the last-seen time per driver, and the trip assignments. That state is **disposable**, and losing a few seconds of positions is acceptable.
  - Kafka holds the position history, partitioned by cell, and is the source the live map reads from.
  - **Two kinds of events, two tools:** business events (a trip requested, accepted, completed) are few and valuable, and go through EventBridge and SQS with DLQs and deduplication, as ridecore does today. Positions are many and short-lived, and go through Kafka. Mixing the two on one channel is what broke the load test (ADR 0008).
  - Nothing a person paid for or agreed to lives here; that stays in DynamoDB.
- **Repository:** `github.com/Chingal/ridecore-location`, MIT, created **private**. It becomes public only by the owner's order, and nothing is pushed without that order. ridecore's README gains a "Scaling track" section with the links.
- **Message contracts** (driver position in, map message out, nearby query) are versioned (`schemaVersion: 1`) and documented in both repositories.
- **Working method:** Claude writes the code, with TDD and a review per plan. Each decision is explained in chat and recorded in `docs/learning-notes.md`. When the owner asks to write a task himself, the test is written first and he writes the code.

## 6. Constraints

- Local and free. Kafka and Redis run in Docker. The laptop has 8 threads and about 7 GB free, so they are sized to it, single-node.
- The Floci-deployed Lambdas must be able to reach the location service, and so must ridecore's local adapter (`make dev`). How depends on Docker networking with Floci, and is checked in a first spike.
- Node 26 and ridecore's existing CI must stay green, with the location path off by default.

## 7. Builder's calls after review (flagged for the owner)

1. **Availability stays in ridecore, and the location service infers it for the map.**
   - **Dispatch:** in Go mode, dispatch asks for the nearest 50 drivers with a fresh position. It keeps those `AVAILABLE` in DynamoDB (one batch read) and offers to the nearest five, the same fan-out as today. An over-fetch of 50 is enough for the load profiles; the scaling ADR states the limit.
   - **Map:** the map and the nearby query show drivers with a fresh position who have **no active trip assignment** (finding 4).
   - **Offline drivers:** a driver who goes OFFLINE stops sending positions and drops out after 30 s. The driver app sets availability through ridecore's HTTP API, as today.
2. **ridecore's DynamoDB index is left alone.** In Go mode, ridecore writes no positions, so drivers never enter the `AVAIL#cell` index and the positions Lambda gets no driver records. `finishTrip` and `setAvailability` keep their current code. With the setting off, nothing changes.
3. **No `category` in the location service's messages for now.** Every trip is `STANDARD`, and the location service does not know vehicles. The map message carries driver id, position and time; the contract notes the field as reserved.
4. **Kafka has two consumers: the live map and replay.** The map broadcaster (goal 3) reads positions in its own consumer group. A `replay` command rebuilds the Redis state from the Kafka history, with an integration test that empties Redis and checks it is restored. Without consumers, Kafka would be decoration, which §4 forbids. (Changed after review with the owner on 2026-11-11: the map first read Redis every second.) The load target is the existing `peak` profile (100 drivers, 200 passengers): the "after" is measured against the same profile as the "before".
5. **One socket per driver** is enforced by the location service for its own sockets, and a new connection replaces the old one. A driver keeps a ridecore session for offers and trips, plus one location socket for positions.
6. **Trip assignments are ordered by version and expire.**
   - **The rule and queue:** ridecore's CDK stack gains an EventBridge rule (`trip.accepted`, `trip.completed`, `trip.cancelled`) that feeds a `ridecore-location-trips` queue with its DLQ. The location service reads it with the AWS SDK, using the Floci endpoint and test credentials from env.
   - **Ordering:** each event carries the trip `version`, and an event older than the stored one is ignored. Assignments also expire after 2 h, as a backstop.
   - **What this means for the passenger:** a late `trip.accepted` can show a passenger their driver for at most a few seconds. ADR 0005 already accepts that limit for the same reason.
7. **Networking is a blocking spike, task 0.** The location service is run so that Floci-deployed Lambdas and `make dev` both reach it. If running it on the host does not work, it joins Floci's Docker network. If neither works, the plan stops and the owner is asked.
8. **Dependency:** this builds on Plan 5 (`make load`, the invariant checker, `docs/load-results/2026-11-11`). PR #5 is merged first.

## 8. Left to the builder

- Folder layout inside the Go repository, package names, the internal interfaces.
- The exact Redis key design (one geo set per cell vs one global set with a radius query) and the Kafka topic and partition count. Each is decided with a short note or an ADR.
- How the 1-second map tick is scheduled per cell, and how the cars in the 3 × 3 cells are batched.
- How the map broadcaster learns which drivers have an active trip (to hide them, §7.1): read the assignments from Redis once per tick, or keep a copy in memory fed by the trip-events queue.
- The consumer group settings (offset reset to latest for the map, since an old position is useless to a watcher; earliest for replay).
- The k6 changes for the Go path, kept as close to the current scenarios as possible.
- The local Kafka image (Apache Kafka in KRaft mode or Redpanda) and the docker-compose layout.
- How the "before" numbers are kept: reuse `docs/load-results/2026-11-11` or rerun them.
