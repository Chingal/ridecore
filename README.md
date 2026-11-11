# ridecore

The backend core of a ride-hailing service: passengers request trips, drivers accept and complete them.
Node.js + TypeScript on AWS serverless (Lambda, DynamoDB), built to be read in one sitting and run locally
with one command, with no AWS account and no cost.

> Status: the trip API and its data model (Plan 1), the event path with its consumers (Plan 2a),
> real-time updates over WebSocket (Plan 2b) and the MCP server for AI agents (Plan 3) are built and
> tested. See [Roadmap](#roadmap) for what is left.

## What it does today

- **Trip lifecycle as a state machine** (pure domain code, no AWS imports):
  `REQUESTED → ACCEPTED → DRIVER_ARRIVED → IN_PROGRESS → COMPLETED → RATED`, with `CANCELLED` allowed from
  the first three states. Any other transition is rejected.
- **HTTP API** for passengers and drivers: request, accept, arrive, start, complete, cancel and rate a trip;
  driver availability and position; a driver's open offers; a passenger's trip history.
- **Dispatch by proximity:** available drivers in the same geohash cell (precision 5) or its neighbours get
  the offer. When two drivers accept at the same time, one wins and the other gets `409 TRIP_ALREADY_TAKEN`.
- **One active trip per passenger and per driver**, enforced atomically with DynamoDB transactions
  (`TransactWriteItems`), not with a read-then-write check.
- **Transactional outbox:** every state change writes the trip and its versioned event (`schemaVersion: 1`)
  in the same transaction, so a transition can never be saved while its event is lost.
- **Idempotency keys** on mutating requests (`Idempotency-Key` header), scoped by role and caller, with expiry.
  The stored response is written in the same transaction as the business change.
- **Authorization per resource:** a passenger only sees and changes their own trips; a driver only acts on
  trips offered or assigned to them. JWT auth fails closed when the secret is missing or too short.
- **Event-driven consumers** ([ADR 0004](docs/decisions/0004-event-delivery.md)): a publisher reads the
  table stream and puts each outbox event on an EventBridge bus; rules route `trip.requested` to a dispatch
  queue and `trip.completed` to a billing queue. Dispatch offers the trip to nearby drivers and fans each
  offer out through SNS to a driver-offers queue; billing records the final fare. Every queue has a
  dead-letter queue, consumers report partial batch failures, and each consumer is idempotent
  (at-least-once delivery, duplicates are expected).
- **Real-time updates over WebSocket** ([ADR 0005](docs/decisions/0005-real-time.md)): API Gateway WebSocket
  API with the same JWT. Trip updates reach the trip's passenger and driver, new offers reach the driver,
  and passengers watching the map see available cars nearby (parked cars on opening, then their moves, throttled by geohash cell). Once a driver is
  on a trip, their position goes only to that trip's passenger. Pushes are driven by the events above; the
  real-time layer never writes trip state.
- **MCP server for AI agents** ([ADR 0003](docs/decisions/0003-mcp-tool-design.md)): four passenger tools
  (`request_trip`, `get_trip_status`, `cancel_trip`, `list_my_trips`) over stdio. It calls the HTTP API with
  one passenger token, so the API's authorization applies unchanged, and returns short trip summaries and
  readable errors such as `ACTIVE_TRIP_EXISTS: The passenger already has an active trip`.
- Structured JSON logs; every response carries an `x-correlation-id` header, and the same id travels in
  the event to every consumer's log lines.

## Architecture

```
            HTTP API (API Gateway)
                     │
                     ▼
        Lambda (Node.js 24 runtime)          local adapter (same handler, port 3000)
   http → app (use cases) → domain (pure)    ── used for fast e2e runs
                     │
                     ▼
     DynamoDB single table  (trips, active-trip reservations,
     offers, idempotency records, outbox events) ── stream enabled
                     │
                     ▼
     stream → publisher Lambda → EventBridge bus `ridecore`
          trip.requested → SQS dispatch ──► offers ──► SNS → SQS driver-offers
          trip.completed → SQS billing  ──► billing record
                           (each queue: 3 receives, then its DLQ)
          every trip.* → SQS notifications ──► notifier ──┐
     stream (driver items) → positions Lambda ────────────┤ PostToConnection
     driver-offers consumer ──────────────────────────────┤
                                                          ▼
     WebSocket API ($connect / $disconnect / $default) ── passengers, drivers, demo/map.html
```

- `src/domain` — trip state machine, fare calculation (haversine distance), domain events and errors.
- `src/app` — use cases: trips, dispatch, drivers.
- `src/http` — routing, validation (zod), JWT auth (jose), responses, the Lambda entry point.
- `src/infra/dynamo` — repositories, single-table keys, transactions, idempotency and dedup stores.
- `src/events` — the outbox publisher, the SQS consumer harness and the consumers (dispatch, driver offers, billing, notifier).
- `src/realtime` — WebSocket routes, the message contract, the pusher and the positions stream handler.
- `src/mcp` — the MCP server: an HTTP client for the passenger routes, the four tools, the stdio entry point.
- `infra/cdk` — the stateful stack in AWS CDK: table, event bus, rules, SNS topic, queues and DLQs.
- `serverless.yml` — the Lambdas (API, publisher, consumers, WebSocket routes, positions) and their triggers, deployed with `osls`
  (the MIT fork of Serverless Framework). It reads the CDK outputs one way only (`scripts/cdk-env.ts`).

## Run it locally

Requirements: Node.js 26 (`.nvmrc`), Docker. AWS runs locally in [Floci](https://github.com/floci-io/floci),
an AWS emulator; nothing reaches a real AWS account.

```bash
npm ci
make up          # starts Floci, deploys the stateful stack (CDK) and the Lambdas (osls), seeds 6 drivers and 1 passenger
make e2e         # full trip flow against the Lambda deployed in Floci
make demo-map    # live map: prints the URL and a token for demo/map.html, then moves the seeded cars
make dev         # same handler as a local server on port 3000
npm run token -- passenger <id>   # prints a dev JWT (make up also prints tokens for the seeded users)
make down
```

Configuration is read in this order: exported env > `.env.local` (yours, git-ignored) > `.env.deploy`
(generated by `make up`) > `.env.example`. Every value in `.env.example` is a non-secret local default.

## Tests and CI

| Level | What it covers | Command |
|---|---|---|
| Unit | domain, use cases, routing, validation, auth, repositories | `npm run test:unit` |
| Integration | repositories, dispatch races and idempotency against DynamoDB in Floci | `npm run test:integration` |
| Integration | consumers' idempotency, "offer once" under concurrency, DLQ redrive, connection and throttle items | `npm run test:integration` |
| End to end | a complete trip: the offer arrives only through the dispatch consumer, the fare only through billing; against the Floci-deployed Lambda and the local adapter | `make e2e`, `make e2e-local` |
| End to end | real time over WebSocket: a car on the map, the offer pushed to the driver, trip updates to both, the car leaving the map, the driver's position only to the passenger | `make e2e` |
| End to end | the MCP server as a child process over stdio: request, one active trip only, status, list, cancel; a driver token and another passenger's trip are refused | `make e2e`, `make e2e-local` |

GitHub Actions runs lint, type checks, unit tests, `cdk synth`, `serverless package`, a dependency audit,
and then integration and e2e tests against Floci. CI needs no secrets and no AWS account. What e2e proves
is the behaviour through the deployed Lambda in Floci; that the infrastructure also deploys to real AWS is
only checked by synthesis and packaging.

## Watch the map

`make demo-map` prints the WebSocket URL and a passenger token. It then drives the six seeded cars around
small loops for two minutes. Open `demo/map.html` (Leaflet + OpenStreetMap), paste both values and press
Connect: the cars move, and any trip that passenger requests shows its state changes as they happen.

## Use it from an AI agent

The MCP server runs on your machine and talks to the agent over stdio. It needs the API URL
(`RIDECORE_API_URL`, written to `.env.deploy` by `make up`; or `http://localhost:3000` with `make dev`)
and a passenger token (`make mcp-token` prints one for the seeded `passenger-1`; `PASSENGER=<id>` for another).

With [Claude Code](https://code.claude.com), from the repository root:

```bash
claude mcp add ridecore --env RIDECORE_MCP_TOKEN="$(make -s mcp-token)" \
  -- node --import "$PWD/scripts/load-env.ts" "$PWD/src/mcp/main.ts"
```

The command is `node` and not `npm run mcp`, because npm prints a banner to stdout and stdout carries only
the protocol. Any MCP client that starts a stdio server works the same way. Then ask, for example, *"Request
a trip from 2.4448, -76.6147 to 2.4594, -76.5996 and tell me its status"*: the agent calls `request_trip`
and gets back

```json
{"tripId":"…","state":"REQUESTED","origin":{"lat":2.4448,"lng":-76.6147},"destination":{"lat":2.4594,"lng":-76.5996},
 "fareEstimate":8202,"currency":"COP","driverAssigned":false,"createdAt":"…","timestamps":{"REQUESTED":"…"}}
```

The token is a 24-hour dev token; when it expires the tools answer `UNAUTHENTICATED` and you add the server
again with a new one.

## Watch an event fail and recover

`make dlq-demo` puts a `trip.completed` event with an unknown `schemaVersion` on the bus. The billing
consumer rejects it on every receive; SQS retries it every 60 s and, after the third receive, moves it
to the billing DLQ. Run on Floci:

```
Put trip.completed with schemaVersion 99 (correlationId dlq-demo-aadc8b20) on bus ridecore.
The billing consumer rejects it on each receive; SQS retries it every 60 s, 3 receives in total.
  t=  0s  billing in flight: 0  billing DLQ: 0
  t= 10s  billing in flight: 1  billing DLQ: 0
  ...
  t=180s  billing in flight: 1  billing DLQ: 0
  t=190s  billing in flight: 0  billing DLQ: 1
billing DLQ: 1 message(s). Move it back with: make redrive QUEUE=billing
```

`make redrive QUEUE=billing` moves the messages back to the queue (after deploying a fix, in real life).

## Decisions

- [ADR 0001 — Toolchain spike](docs/decisions/0001-toolchain-spike.md): why the Lambda runs on `nodejs24.x`,
  why `osls` instead of Serverless v4, and how CDK and osls deploy to Floci.
- [ADR 0002 — Dependency audit](docs/decisions/0002-dependency-audit.md): how audit findings are handled in CI.
- [ADR 0003 — MCP server tool design](docs/decisions/0003-mcp-tool-design.md): four task-shaped tools instead
  of one per endpoint, and when to add tool search or code execution.
- [ADR 0004 — Event delivery](docs/decisions/0004-event-delivery.md): outbox → stream → EventBridge → SQS
  with DLQs, SNS fan-out, idempotent consumers, the CDK/osls split, and the Floci spike behind it.
- [ADR 0005 — Real-time updates](docs/decisions/0005-real-time.md): WebSocket API, routing by actor, the three
  delivery patterns, client-side ordering, the map throttle, and the Floci spike behind it.
- [Design spec](docs/superpowers/specs/2026-11-09-ridecore-design.md) and
  [implementation plan](docs/superpowers/plans/2026-11-09-ridecore-core.md).

## Roadmap

1. ~~**Events (Plan 2a):** outbox publisher, SQS consumers with DLQs, SNS fan-out, redrive demo.~~ Done.
2. ~~**Real time (Plan 2b):** WebSocket API, trip updates, offers, cars on the map, demo map page.~~ Done.
3. ~~**MCP server (Plan 3):** four passenger tools for AI agents over the real API.~~ Done.

Known limitations: only `STANDARD` trips (fare by straight-line distance); an unaccepted trip waits until the
passenger cancels (no expiry or re-offer); auth is a minimal JWT stand-in, not production identity.

## License

[MIT](LICENSE) © 2026 Rodrigo Chingal
