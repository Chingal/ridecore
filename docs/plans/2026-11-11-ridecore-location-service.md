# ridecore-location (Go service) Implementation Plan — Plan 6

**Goal:** A new Go repository, `ridecore-location`, that takes driver positions, answers "who is near this point?", feeds the live map from Kafka, and pushes the assigned driver's position to that trip's passenger.

**Architecture:** One Go binary (`cmd/location`) with four parts: driver ingest over WebSocket (writes Redis and Kafka), the nearby query over HTTP (reads Redis), the live map (a Kafka consumer that keeps cells in memory and ticks once a second to passenger sockets), and a trip-assignment reader (SQS, fed by ridecore's EventBridge rule, writes Redis). A second binary (`cmd/replay`) rebuilds Redis from Kafka. Standard library `net/http`, no framework.

**Tech Stack:** Go 1.27; `github.com/redis/go-redis/v9` v9.23.0; `github.com/twmb/franz-go` v1.22.3 (`pkg/kgo`, plus `pkg/kadm` for topic creation); `github.com/coder/websocket` v1.8.15; `github.com/golang-jwt/jwt/v5` v5.3.1; `github.com/mmcloughlin/geohash` v0.10.0; `golang.org/x/time` v0.16.0 (`rate`); `github.com/aws/aws-sdk-go-v2/service/sqs` v1.53.0; `github.com/testcontainers/testcontainers-go` v0.45.0 (redis and kafka modules); `log/slog`. Docker: `apache/kafka:4.4.0` (KRaft, single node) and Redis 8 alpine (exact stable tag pinned in Task 1 after `docker pull`).

**Spec:** `docs/design/2026-11-11-ridecore-location-design.md` (in the ridecore repository). Plan 7 (`2026-11-11-ridecore-location-integration.md`) does the ridecore side and the measurement.

## Global Constraints

- Repository `~/Proyectos/ridecore-location`, module `github.com/Chingal/ridecore-location`, MIT license, created **private** on GitHub only by the owner's order; nothing is pushed without that order. Commits carry no `Co-Authored-By`.
- No client or employer name, no mention of employment, no copied code, in any tracked file.
- No web framework: `net/http` with method-and-path patterns (`mux.HandleFunc("GET /v1/nearby", …)`).
- JWT: HS256 only, `exp` required, `alg: none` and every other algorithm rejected; claims `sub` (non-empty) and `role` (`passenger` | `driver`) — the same rules as ridecore's `src/http/auth.ts`. The secret is `RIDECORE_JWT_SECRET`, at least 32 characters, no default.
- WebSocket handshake as in ridecore: subprotocols `["ridecore.v1", <token>]`; the server answers with `ridecore.v1` only. The token never appears in a log line.
- Every message in or out carries `schemaVersion: 1`. No `category` field (reserved in the contract doc).
- Fresh position = seen within **30 s**. Positions every **3 s**. Map: **one message per watched cell per second**, cars of the **3 × 3** geohash-5 block. Assignments expire after **2 h**.
- Redis state is disposable. Nothing a person paid for or agreed to is stored here.
- Sized for a laptop (8 threads, ~7 GB free): single-node Kafka and Redis.
- Every decision recorded as an ADR in `docs/adr/` (with the rejected alternatives and what would change the choice) and every part explained in `docs/learning-notes.md` with: the Go concept, one interview question, how to answer it.
- When the owner asks to write a task himself: write the failing test, hand it over, he writes the code.

## Review Focus

1. **A driver whose socket drops and reconnects in the same second** — the new socket must win; the old socket's close must not remove the new one from the hub. Test in Task 6.
2. **A slow or stuck passenger socket** — one watcher that does not read must not delay the tick for the other watchers. Test in Task 9.
3. **Trip events out of order** (`trip.completed` v5 delivered before `trip.accepted` v3) — the late accept must not create an assignment. Test in Task 4.
4. **Positions with NaN, ±Inf, out-of-range lat/lng, or extra fields / oversize frames** — rejected with an error message, never stored, never published. Test in Task 6.
5. **Kafka or Redis down at start or mid-run** — the process starts its HTTP server, `/healthz` reports the failing dependency with 503, ingest answers `UNAVAILABLE` on the socket instead of panicking. Test in Task 11.

---

### Task 0: Networking spike (blocking, throwaway)

**Goal:** know the URL a Floci-deployed Lambda and `make dev` use to reach a service on the host. Nothing from this task is kept except the answer.

- [ ] **Step 1:** In ridecore, `make up`. Run `python3 -m http.server 8090` on the host.
- [ ] **Step 2:** Find the network of a Floci Lambda container: trigger any route (`curl $RIDECORE_API_URL/me/trips`), then `docker ps --filter name=ridecore` and `docker inspect -f '{{json .NetworkSettings.Networks}}' <lambda container>`.
- [ ] **Step 3:** From a container on that same network, try in order and keep the first that answers 200:
  `docker run --rm --network <net> curlimages/curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:8090/` (add `--add-host host.docker.internal:host-gateway` if it does not resolve), then the network's gateway IP, then joining the location stack to Floci's network (`ridecore_default`) and using the container name.
- [ ] **Step 4:** Check whether Floci passes extra hosts to Lambda containers (Floci docs / env such as `LAMBDA_DOCKER_FLAGS`); if the Lambda container cannot resolve `host.docker.internal`, the answer is the gateway IP or the shared network.
  Expected: one working URL for Lambdas (`LOCATION_URL_FOR_LAMBDA`) and `http://127.0.0.1:8090` for `make dev`.
- [ ] **Step 5:** If no option works, **stop and ask the owner**. Otherwise write the answer as `docs/adr/0001-local-networking.md` in the new repository during Task 1 (decision, the tries that failed, how it maps to AWS: a private ALB or Cloud Map name).

### Task 1: Repository skeleton, local stack and CI

**Files:**
- Create: `go.mod`, `LICENSE` (MIT, Rodrigo Chingal, 2026), `README.md` (what it is, link to ridecore, "Status: in progress"), `.gitignore`, `Makefile`, `compose.yml`, `.golangci.yml`, `.github/workflows/ci.yml`, `cmd/location/main.go`, `internal/health/health.go`, `internal/health/health_test.go`, `docs/adr/0001-local-networking.md`, `docs/learning-notes.md`.

**Interfaces:**
- Produces: `health.Handler(checks map[string]func(context.Context) error) http.Handler` — 200 `{"status":"ok"}` when every check passes within 1 s, else 503 `{"status":"degraded","failing":["redis",…]}` (names sorted).
- Produces: Makefile targets `up` (compose up `redis` `kafka` with `--wait`), `down`, `run` (`go run ./cmd/location`), `test` (`go test -race ./...` without the `integration` tag), `integration` (`go test -race -tags integration ./...`), `lint` (`go vet ./... && golangci-lint run && govulncheck ./...`).

- [ ] **Step 1:** `git init`, `go mod init github.com/Chingal/ridecore-location`; pin the Redis tag (`docker pull redis:8-alpine`, read the exact version, write it in `compose.yml`).
- [ ] **Step 2: Failing test** `TestHealthReportsFailingChecks`: two checks, `redis` errors → 503 and body `{"status":"degraded","failing":["redis"]}`; `TestHealthOK`: both nil → 200 `{"status":"ok"}`; `TestHealthCheckTimeout`: a check that blocks 2 s → 503 within 1.5 s.
- [ ] **Step 3:** Run `go test ./internal/health/` → FAIL (undefined: Handler).
- [ ] **Step 4:** Implement `health.Handler`; checks run concurrently with a 1 s context.
- [ ] **Step 5:** Run → PASS. `compose.yml`: `redis` (port `127.0.0.1:6379`, `--save "" --appendonly no`, healthcheck `redis-cli ping`), `kafka` (`apache/kafka:4.4.0`, KRaft single node, `127.0.0.1:9092`, `KAFKA_NUM_PARTITIONS=12`, `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`, heap `-Xmx512m`, healthcheck with `kafka-broker-api-versions.sh`). Both on a network named per Task 0's answer. `make up` → both healthy.
- [ ] **Step 6:** CI (`ubuntu-latest`, `actions/setup-go` with `go-version-file: go.mod`): jobs `lint` (vet, golangci-lint with `gosec`, `errcheck`, `bodyclose`, `noctx`, `govet`, `staticcheck` enabled; govulncheck) and `test`; `integration` job runs `make integration` (testcontainers uses the runner's Docker).
- [ ] **Step 7:** `docs/learning-notes.md` with its section format (Go concept / interview question / answer) and the first entry: Go modules and `internal/`. ADR 0001 from Task 0.
- [ ] **Step 8: Commit** `chore: repository skeleton, local Redis and Kafka, CI`.

### Task 2: JWT verification

**Files:** Create `internal/auth/auth.go`, `internal/auth/auth_test.go`, `docs/adr/0002-identity-hs256-now-jwks-later.md`.

**Interfaces:**
- Produces: `type Role string` with `RolePassenger = "passenger"`, `RoleDriver = "driver"`; `type Actor struct{ ID string; Role Role }`; `func Verify(token string, secret []byte, now time.Time) (Actor, error)`; `var ErrUnauthenticated = errors.New("unauthenticated")` (every failure wraps it); `func TokenFromSubprotocols(protocols []string) (string, bool)` — true only when the list is exactly `["ridecore.v1", <non-empty token>]`; `const Subprotocol = "ridecore.v1"`.

- [ ] **Step 1: Failing tests** (table-driven `TestVerify`; tokens built in the test with `jwt.NewWithClaims`):
  valid passenger → `Actor{ID:"passenger-1", Role:"passenger"}`; expired → `ErrUnauthenticated`; no `exp` → `ErrUnauthenticated`; `alg: none` (hand-built `header.payload.`) → `ErrUnauthenticated`; HS512 with the same secret → `ErrUnauthenticated`; wrong secret; `role: "admin"`; empty `sub`; empty token. `TestTokenFromSubprotocols`: `["ridecore.v1","abc"]` → `"abc",true`; `["ridecore.v1"]`, `["x","abc"]`, `["ridecore.v1",""]`, three entries → `false`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `jwt.Parse(token, keyFunc, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithTimeFunc(func() time.Time { return now }))`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** ADR 0002: shared HS256 secret now; production would use asymmetric keys and JWKS so this service can verify but never mint. Learning note: why pinning the algorithm matters (the `alg` confusion attack).
- [ ] **Step 6: Commit** `feat(auth): verify ridecore HS256 tokens`.

### Task 3: Geohash cells and position validation

**Files:** Create `internal/geo/geo.go`, `internal/geo/geo_test.go`.

**Interfaces:**
- Produces: `const Precision = 5`; `type Point struct{ Lat, Lng float64 }`; `func Cell(p Point) string`; `func Block(cell string) []string` (the cell and its 8 neighbours, 9 distinct values, the cell first); `func Valid(p Point) bool` (finite, lat in [-90,90], lng in [-180,180]).
- [ ] **Step 1: Failing tests:** `Cell(Point{2.45,-76.47}) == "d23tg"` (ridecore's `LOAD_CENTRE`); `len(Block("d23tg")) == 9`, all distinct, `Block(...)[0] == "d23tg"`; `Valid` false for `NaN`, `+Inf`, `90.0001`, `-180.0001`; true for `{-90,180}`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with `mmcloughlin/geohash` (`EncodeWithPrecision`, `Neighbors`). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(geo): geohash-5 cells and point validation`.

### Task 4: Redis store — positions, nearby, assignments

**Files:** Create `internal/store/store.go`, `internal/store/assign.lua`, `internal/store/store_integration_test.go` (`//go:build integration`, Redis via testcontainers), `docs/adr/0003-redis-keys.md`.

**Interfaces:**
- Consumes: `geo.Point`.
- Produces:
  - `type Position struct{ DriverID string; Point geo.Point; At time.Time }`
  - `type Near struct{ DriverID string; Point geo.Point; DistanceM float64; At time.Time }`
  - `type Assignment struct{ TripID, DriverID, PassengerID string }`
  - `type Store struct{…}`; `func New(rdb *redis.Client) *Store`
  - `(*Store).PutPosition(ctx, Position) error` — keeps the newer `At` only (a late position does not overwrite a newer one).
  - `(*Store).Nearby(ctx, p geo.Point, limit int, now time.Time) ([]Near, error)` — fresh (At ≥ now−30 s), not busy, nearest first, at most `limit`.
  - `(*Store).Accept(ctx, tripID, driverID, passengerID string, version int) error`
  - `(*Store).Finish(ctx, tripID string, version int) error`
  - `(*Store).TripOfDriver(ctx, driverID string) (Assignment, bool, error)`
  - `(*Store).BusyDrivers(ctx) (map[string]struct{}, error)`
  - `(*Store).Prune(ctx, now time.Time) (int, error)` — removes drivers not seen for 30 s.
  - `(*Store).Ping(ctx) error`
- **Key design (decided here, ADR 0003):** one global geo set `loc:geo` (`GEOADD`), one sorted set `loc:seen` (score = At in ms), `GEOSEARCH loc:geo FROMLONLAT … BYRADIUS 5 km ASC COUNT min(4·limit, 200) WITHDIST WITHCOORD`, then filter by `loc:seen` and `loc:busy`. Assignments: hash `loc:trip:{tripID}` {driverId, passengerId, version, finished} with 2 h TTL, `loc:driver:{driverID}` → tripID with 2 h TTL, set `loc:busy`. `Accept` and `Finish` run in `assign.lua` (embedded with `//go:embed`): an event whose version is ≤ the stored version is ignored; `Finish` stores `finished=1` with its version so a late `Accept` with a lower version is ignored. The ADR compares one-set-per-cell (cheaper writes when sharded by city, needs 9 reads) and states when to switch: the global set stops fitting one Redis node, or cities are split.
- [ ] **Step 1: Failing tests:** `TestNearbyNearestFirstAndFresh` (drivers at 100 m, 300 m and 2 km, plus a fourth at 50 m last seen 31 s ago → exactly the first three, in that order); `TestNearbyLimit`; `TestPutPositionKeepsNewer` (older At after newer → newer kept); `TestBusyDriverHiddenFromNearby` (Accept → hidden; Finish → visible); `TestAcceptAfterFinishIgnored` (Finish v5 then Accept v3 → `TripOfDriver` false, not busy) — **Review Focus 3**; `TestAssignmentTTL` (TTL on both keys between 7190 s and 7200 s); `TestPrune`.
- [ ] **Step 2:** `make up` not needed (testcontainers). Run `go test -tags integration ./internal/store/` → FAIL.
- [ ] **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Learning note: Redis GEO commands, Lua for atomic compare-and-set, why the state is disposable.
- [ ] **Step 6: Commit** `feat(store): Redis positions, nearby query and versioned trip assignments`.

### Task 5: Kafka position topic — producer

**Files:** Create `internal/stream/stream.go`, `internal/stream/message.go`, `internal/stream/message_test.go`, `internal/stream/stream_integration_test.go`, `docs/adr/0004-kafka-positions-topic.md`.

**Interfaces:**
- Consumes: `store.Position`, `geo.Cell`.
- Produces:
  - `const Topic = "driver-positions"`, `const Partitions = 12`
  - `type PositionMessage struct{ SchemaVersion int \`json:"schemaVersion"\`; DriverID string \`json:"driverId"\`; Lat, Lng float64; At time.Time \`json:"at"\` }` (JSON names `lat`, `lng`)
  - `func Encode(p store.Position) (key, value []byte)` — key = `geo.Cell(p.Point)`; `func Decode(value []byte) (store.Position, error)` (rejects `schemaVersion != 1`)
  - `func EnsureTopic(ctx, cl *kgo.Client) error` (kadm, idempotent: "already exists" is success; retention 24 h)
  - `type Producer struct{…}`; `func NewProducer(cl *kgo.Client) *Producer`; `(*Producer).Publish(ctx, store.Position)` — async `cl.Produce`, errors counted and logged, never blocking the socket loop. Client options: `kgo.ProducerLinger(20*time.Millisecond)`, `kgo.RequiredAcks(kgo.LeaderAck())`, `kgo.DisableIdempotentWrite()` (positions are best effort; the ADR says so).
- [ ] **Step 1: Failing tests:** `TestEncodeKeyIsCell` (key `d23tg` for `LOAD_CENTRE`); `TestDecodeRejectsOtherSchema`; integration `TestPublishLandsOnCellPartition` (two positions in the same cell land on the same partition; the consumed value decodes to the input).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** ADR 0004: key by cell (map reads by area, keeps one cell's order) vs by driver (keeps one driver's order); 12 partitions (a few times the laptop's cores, room for 12 map instances); what is lost (order across a cell border, handled by `At`). Learning note: partitions, keys, acks, linger.
- [ ] **Step 6: Commit** `feat(stream): driver-positions topic keyed by cell`.

### Task 6: Driver ingest WebSocket

**Files:** Create `internal/ingest/ingest.go`, `internal/ingest/ingest_test.go`, `internal/wsutil/wsutil.go` (accept with subprotocol + auth, shared by Task 9).

**Interfaces:**
- Consumes: `auth.Verify`, `auth.TokenFromSubprotocols`, `geo.Valid`, `store.Position`.
- Produces:
  - `wsutil.Accept(w, r, secret []byte, now func() time.Time, want auth.Role) (*websocket.Conn, auth.Actor, bool)` — wrong role or bad token → HTTP 401/403 before the upgrade; read limit 1 KiB (`conn.SetReadLimit(1024)`).
  - `type Positions interface{ PutPosition(ctx, store.Position) error; TripOfDriver(ctx, string) (store.Assignment, bool, error) }`
  - `type Publisher interface{ Publish(ctx, store.Position) }`
  - `type PassengerNotifier interface{ SendDriverPosition(passengerID, tripID string, p store.Position) }` (implemented by Task 9's hub)
  - `func Handler(cfg Config, pos Positions, pub Publisher, notify PassengerNotifier) http.Handler` mounted at `GET /v1/drivers/ws`; `type Config struct{ Secret []byte; Now func() time.Time; MinInterval time.Duration /* 1 s */; Burst int /* 2 */ }`.
- Behaviour: client message `{"action":"position","lat":…,"lng":…}` (unknown fields rejected with `json.Decoder.DisallowUnknownFields`) or `{"action":"ping"}` → `{"schemaVersion":1,"type":"pong"}`. A valid position: `PutPosition` (At = server now), `Publish`, then if `TripOfDriver` finds a trip, `SendDriverPosition`. Errors are sent as `{"schemaVersion":1,"type":"error","code":…,"message":…}` with codes `INVALID_MESSAGE`, `RATE_LIMITED`, `UNAVAILABLE` (store error). One socket per driver: a registry `map[driverID]*conn` under a mutex; a new socket closes the old one with status 4000 `"replaced"`; the old socket's cleanup removes the entry **only if it is still the same pointer**.
- [ ] **Step 1: Failing tests** (`httptest.Server`, `websocket.Dial` with subprotocols, fakes for the three interfaces):
  `TestRejectsPassengerToken` (403, no upgrade); `TestRejectsMissingToken` (401); `TestValidPositionStoredAndPublished`; `TestInvalidPositionsRejected` (table: NaN as `1e999` → JSON error, lat 91, extra field, wrong action, 2 KiB frame closes the socket with 1009) — **Review Focus 4**, none reach the fakes; `TestRateLimited` (5 positions in 100 ms → at least 3 `RATE_LIMITED`); `TestSecondSocketReplacesFirst` (first gets close 4000; a position on the second is stored) and `TestOldSocketCloseKeepsNewEntry` — **Review Focus 1**; `TestPositionForwardedToPassenger` (fake TripOfDriver returns trip-1/passenger-1 → notifier called once); `TestStoreDownAnswersUnavailable` — **Review Focus 5**.
- [ ] **Step 2:** Run `go test -race ./internal/ingest/` → FAIL. **Step 3:** Implement (one goroutine per socket reading in a loop; `rate.NewLimiter(rate.Every(cfg.MinInterval), cfg.Burst)` per socket). **Step 4:** Run → PASS.
- [ ] **Step 5:** Learning note: goroutine per connection, `context` cancellation, mutex vs channel for the registry, the race detector.
- [ ] **Step 6: Commit** `feat(ingest): driver positions over WebSocket`.

### Task 7: Nearby query

**Files:** Create `internal/nearby/nearby.go`, `internal/nearby/nearby_test.go`.

**Interfaces:**
- Consumes: `store.Near`, `geo.Valid`.
- Produces: `type Finder interface{ Nearby(ctx, geo.Point, int, time.Time) ([]store.Near, error) }`; `func Handler(f Finder, key []byte, now func() time.Time) http.Handler` mounted at `GET /v1/nearby?lat=&lng=&limit=`.
- Auth: `Authorization: Bearer <LOCATION_INTERNAL_KEY>` compared with `subtle.ConstantTimeCompare`; the key is a separate secret of at least 32 characters (service-to-service, not a user token). `limit` default 10, max 50.
- Response 200: `{"schemaVersion":1,"drivers":[{"driverId":"…","lat":…,"lng":…,"distanceM":…,"at":"RFC3339"}]}`; 400 `{"schemaVersion":1,"code":"INVALID_QUERY",…}`; 401 `UNAUTHENTICATED`; 503 `UNAVAILABLE` on store error.
- [ ] **Step 1: Failing tests:** `TestNearbyOK` (fake returns two; JSON shape exact); `TestNearbyBadKey` 401; `TestNearbyValidation` (missing lat, lat 91, limit 0, limit 51, limit `abc` → 400); `TestNearbyDefaultLimit` (fake sees 10); `TestNearbyStoreDown` 503.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(nearby): HTTP nearby-drivers query`.

### Task 8: Trip assignments from SQS

**Files:** Create `internal/trips/trips.go`, `internal/trips/trips_test.go`.

**Interfaces:**
- Consumes: `store.(*Store).Accept`, `Finish`.
- Produces: `type Assigner interface{ Accept(ctx, tripID, driverID, passengerID string, version int) error; Finish(ctx, tripID string, version int) error }`; `type Queue interface{ ReceiveMessage(ctx, *sqs.ReceiveMessageInput, ...func(*sqs.Options)) (*sqs.ReceiveMessageOutput, error); DeleteMessage(ctx, *sqs.DeleteMessageInput, ...func(*sqs.Options)) (*sqs.DeleteMessageOutput, error) }`; `func Run(ctx, q Queue, queueURL string, a Assigner, log *slog.Logger) error` (long poll 20 s, 10 messages, returns when ctx ends); `func Handle(ctx, body string, a Assigner) error`.
- Message body: the EventBridge envelope `{"detail-type":"trip.accepted","detail":<TripEvent>}`; `detail.schemaVersion` must be 1; `trip.accepted` needs `payload.driverId` and `payload.passengerId`; `trip.completed` and `trip.cancelled` call `Finish`; any other type is deleted without effect. A malformed body or an `Assigner` error is **not** deleted (it returns to the queue and ends in the DLQ after the queue's max receives); success is deleted.
- [ ] **Step 1: Failing tests:** `TestAcceptedSetsAssignment` (body fixture copied from a real EventBridge-to-SQS message shape; assert Accept args `("trip-1","driver-1","passenger-1",3)`); `TestCompletedAndCancelledFinish`; `TestOtherTypesIgnored`; `TestMalformedNotDeleted` (fake queue records no delete); `TestAssignerErrorNotDeleted`; `TestSchemaVersion2Rejected`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Learning note: at-least-once delivery, idempotency by version, DLQ.
- [ ] **Step 6: Commit** `feat(trips): trip assignments from ridecore events`.

### Task 9: Live map — Kafka consumer, cells in memory, 1 s tick, passenger sockets

**Files:** Create `internal/livemap/cells.go`, `internal/livemap/hub.go`, `internal/livemap/consumer.go`, `internal/livemap/cells_test.go`, `internal/livemap/hub_test.go`, `internal/livemap/consumer_integration_test.go`, `docs/adr/0005-live-map-from-kafka.md`.

**Interfaces:**
- Consumes: `stream.Decode`, `geo.Cell`, `geo.Block`, `wsutil.Accept`, `store.Position`.
- Produces:
  - `type Cells struct{…}`; `func NewCells() *Cells`; `(*Cells).Apply(p store.Position)` (keeps newer `At` per driver; moves a driver between cells); `(*Cells).Snapshot(cell string, now time.Time, busy map[string]struct{}) []Car` (cars of `geo.Block(cell)`, fresh within 30 s, not busy, sorted by driver id); `(*Cells).Evict(now time.Time)` (drops entries older than 30 s); `type Car struct{ DriverID string \`json:"driverId"\`; Lat, Lng float64; At time.Time \`json:"at"\` }`.
  - `type Hub struct{…}`; `func NewHub(cells *Cells, busy func(ctx) (map[string]struct{}, error), now func() time.Time, log *slog.Logger) *Hub`; `(*Hub).Handler(secret []byte, maxSocketsPerPassenger int /* 3 */) http.Handler` at `GET /v1/map/ws`; `(*Hub).Tick(ctx)` (one tick); `(*Hub).Run(ctx)` (ticks every 1 s); `(*Hub).SendDriverPosition(passengerID, tripID string, p store.Position)` (implements `ingest.PassengerNotifier`).
  - `func Consume(ctx, cl *kgo.Client, cells *Cells) error` — group `livemap`, `kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd())` (an old position is useless to a watcher), auto-commit.
- Messages out: `{"schemaVersion":1,"type":"cars","cell":"d23tg","cars":[…],"at":"…"}` once per second per watched cell (built once per cell and fanned out to its watchers); `{"schemaVersion":1,"type":"driver_position","tripId":…,"lat":…,"lng":…,"at":…}` to every socket of that passenger. Client messages: `{"action":"watch","lat","lng"}` (one watched cell per socket; a new watch replaces it; at most 1 watch per second per socket, else `RATE_LIMITED`), `ping`.
- Slow sockets: each socket has a send buffer of 4 messages; when full, the newest `cars` message is dropped for that socket (counted); a write that takes more than 5 s closes the socket. The tick never waits on a socket.
- [ ] **Step 1: Failing tests:**
  `TestCellsKeepsNewest` (out-of-order At across a cell border → newest wins, driver only in the new cell); `TestSnapshotBlockFreshNotBusy`; `TestEvict`;
  `TestHubSendsOncePerCellPerTick` (two watchers on the same cell, one on another → each gets exactly one `cars` per `Tick`);
  `TestSlowWatcherDoesNotBlockTick` (a watcher that never reads; 20 ticks finish in < 200 ms; the healthy watcher gets 20) — **Review Focus 2**;
  `TestMaxSocketsPerPassenger` (4th socket → close 1008);
  `TestDriverRoleCannotWatch` (403);
  `TestSendDriverPositionReachesOnlyThatPassenger`;
  integration `TestConsumeAppliesPositions` (produce to the topic → `Snapshot` has the car within 5 s).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run `go test -race ./internal/livemap/` and the integration test → PASS.
- [ ] **Step 5:** ADR 0005: the map reads Kafka in a consumer group (scales by partitions) instead of polling Redis; cost of a few ms of delay; **the multi-instance limit** — a watcher on instance A whose cell's partition is on B — and the two answers (route watchers to the owner of their cells; or each instance assigns itself the partitions its watchers need, outside the group), with the builder's choice (flagged for the owner): **each instance reads the partitions its watchers need** (no routing layer; costs duplicate reads when watchers spread), and when to switch. Learning note: consumer groups, offsets, rebalancing, backpressure.
- [ ] **Step 6: Commit** `feat(livemap): live map fed by Kafka, one message per cell per second`.

### Task 10: Replay command

**Files:** Create `cmd/replay/main.go`, `internal/replay/replay.go`, `internal/replay/replay_integration_test.go`.

**Interfaces:**
- Consumes: `stream.Decode`, `store.(*Store).PutPosition`.
- Produces: `func Replay(ctx, cl *kgo.Client, s *store.Store) (int, error)` — reads every partition of `driver-positions` from the start **without a group**, up to the high watermark read at start (`kadm.ListEndOffsets`), applies each position with `PutPosition` (which keeps the newest), returns the count.
- [ ] **Step 1: Failing test** `TestReplayRestoresRedis`: publish 3 positions for 2 drivers (driver-1 twice), `FLUSHALL`, `Replay` → 3, `Nearby` (with `now` = the last At) returns both drivers, driver-1 at its second point.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `cmd/replay` reads the same env as the service. **Step 4:** Run → PASS.
- [ ] **Step 5:** Learning note: why a log that can be replayed is the point of Kafka here.
- [ ] **Step 6: Commit** `feat(replay): rebuild Redis from the Kafka history`.

### Task 11: Service wiring, security limits and shutdown

**Files:** Create `internal/config/config.go`, `internal/config/config_test.go`, `internal/server/server.go`, `internal/server/server_test.go`; modify `cmd/location/main.go`.

**Interfaces:**
- Consumes: every handler above; `health.Handler`.
- Produces:
  - `config.FromEnv(getenv func(string) string) (Config, error)`: `LOCATION_ADDR` (default `127.0.0.1:8090`), `REDIS_ADDR` (default `127.0.0.1:6379`), `KAFKA_BROKERS` (default `127.0.0.1:9092`), `RIDECORE_JWT_SECRET` (required, ≥ 32), `LOCATION_INTERNAL_KEY` (required, ≥ 32), `LOCATION_TRIPS_QUEUE_URL` (optional; empty disables the reader with a warning), `AWS_ENDPOINT_URL` / `AWS_REGION` for Floci. Errors name the variable, never its value.
  - `server.New(cfg config.Config, routes http.Handler) *http.Server`: `ReadHeaderTimeout 5s`, `ReadTimeout 10s`, `WriteTimeout 10s`, `IdleTimeout 60s`, `MaxHeaderBytes 16<<10`; middleware: panic recovery (500 `{"code":"INTERNAL"}`, stack in the log), `http.MaxBytesReader` 4 KiB on bodies, per-IP limiter on WebSocket upgrades (10/s, burst 20, entries idle for 5 min removed), a request log line without the `Sec-WebSocket-Protocol` and `Authorization` headers.
  - Routes: `GET /healthz`, `GET /v1/nearby`, `GET /v1/drivers/ws`, `GET /v1/map/ws`.
  - `main`: build clients; `EnsureTopic`; start `Consume`, `Hub.Run`, `trips.Run`, a pruner (`Store.Prune` and `Cells.Evict` every 10 s); `signal.NotifyContext` for SIGINT/SIGTERM; `Shutdown` with 10 s.
- [ ] **Step 1: Failing tests:** `TestConfigFailsClosed` (missing secret, short secret, missing internal key → error naming the variable, and the value absent from the message); `TestServerTimeouts` (fields equal the values above); `TestRecoverReturns500`; `TestBodyLimit` (5 KiB body → 413); `TestUpgradeRateLimitPerIP` (25 quick upgrades from one IP → some 429); `TestLogOmitsToken` (captured slog output has no token string); `TestHealthDegradedWhenRedisDown` (point at a closed port → `/healthz` 503 listing `redis`) — **Review Focus 5**.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. `make up && make run` then `curl 127.0.0.1:8090/healthz` → 200.
- [ ] **Step 5:** Learning note: `http.Server` timeouts and slowloris, graceful shutdown, why not a framework (ADR 0006 below).
- [ ] **Step 6: Commit** `feat: wire the service with timeouts, limits and graceful shutdown`.

### Task 12: Contracts, ADRs on choices not taken, README

**Files:** Create `docs/contracts.md`, `docs/adr/0006-stdlib-net-http.md`, `docs/adr/0007-technology-not-used.md`, `docs/adr/0008-aws-shape.md`; modify `README.md`, `docs/learning-notes.md`.
- [ ] **Step 1:** `docs/contracts.md`: every message in and out (driver socket, map socket, nearby query, Kafka value, SQS body) with `schemaVersion: 1`, an example each, and `category` marked reserved.
- [ ] **Step 2:** ADR 0006: `net/http` patterns since Go 1.22; Gin and Echo rejected (routing was their main use); Fiber rejected (fasthttp, not `net/http`-compatible); what each security control replaces from a framework. ADR 0007: RabbitMQ, Erlang/Elixir and Rust not used — and when each would be the right call. ADR 0008: the AWS shape (ECS/Fargate, ElastiCache, MSK or Kinesis, an ALB with WebSockets, Cloud Map), not built, not paid.
- [ ] **Step 3:** README: what it is, a Mermaid diagram (`flowchart TB`), `make up && make run`, the routes, link to ridecore and its ADR 0008, status and limits (laptop numbers are not AWS capacity).
- [ ] **Step 4:** Verify: `grep -riE "<client and employer names from the private notes>" .` → nothing; `make lint test integration` → all pass.
- [ ] **Step 5: Commit** `docs: contracts, ADRs and README`.
