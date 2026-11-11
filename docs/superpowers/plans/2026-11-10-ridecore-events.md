# ridecore Events (Plan 2a of 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every outbox event to asynchronous consumers: DynamoDB Streams → publisher Lambda → EventBridge → SQS queues (each with a DLQ) → idempotent consumer Lambdas; dispatch offers fan out through SNS; a scripted DLQ → redrive demo.

**Architecture:** Plan 1 already writes each state change and its `TripEvent` (outbox item, `entity: 'EVENT'`) in one DynamoDB transaction, and the table stream is on (`NEW_IMAGE`). A publisher Lambda reads the stream, keeps only outbox INSERTs and puts them on the `ridecore` EventBridge bus. Rules route `trip.requested` to the dispatch queue and `trip.completed` to the billing queue. The dispatch consumer offers the trip (existing `offerTrip` logic) and publishes one SNS message per offer; the SNS topic feeds the driver-offers queue. CDK owns every stateful resource (bus, rules, topic, subscription, queues, DLQs, queue policies); osls owns the functions and their stream/SQS triggers, reading CDK outputs one way only.

**Tech Stack:** as Plan 1, plus `@aws-sdk/client-eventbridge`, `@aws-sdk/client-sns`, `@aws-sdk/client-sqs` (runtime-provided on Lambda, kept external by esbuild), `@types/aws-lambda` stream/SQS types.

**Spec:** `docs/superpowers/specs/2026-11-09-ridecore-design.md` (§5 behaviour rules "Dispatch", "Event delivery", "Idempotency", "Observability"; §7 "Events", "Infrastructure as code"; §9 step 2). Real-time (§5b, WebSocket + demo map) is **Plan 2b**, not this plan.

## Global Constraints

- Node `>=26.13.0` for development, tests and CI; Lambda runtime `nodejs24.x` (ADR 0001); code must run on Node 24.
- TypeScript `strict: true`; no `any` in `src/`. ESM, erasable-only TS syntax (no enums, no parameter properties) wherever CDK or scripts run it with native type stripping.
- No code, names, branding or data from the original 2016-2018 client platform; no client or employer names anywhere.
- Local runs and CI need no AWS account, paid service or real secret. Floci `http://localhost:4567`, `us-east-1`, `test/test`.
- Every resource has exactly one owner (CDK or osls); references go one way only: osls reads CDK outputs (via the Makefile), never the reverse.
- Code, comments, docs, commits in English. Commits without `Co-Authored-By`. No `git push` without the owner's order. Work on branch `feat/events`.
- Event envelope stays `schemaVersion: 1`; adding an optional field is allowed, renaming or removing one is not.
- Resource names (fixed, used by tests and docs): bus `ridecore`; event source `ridecore.trips`; queues `ridecore-dispatch`, `ridecore-billing`, `ridecore-driver-offers`, each with `<name>-dlq`; SNS topic `ridecore-driver-offers`. Redrive `maxReceiveCount: 3`; queue visibility timeout 60 s (6 × the 10 s Lambda timeout); DLQ retention 14 days.

## Rulings on the spec (flagged for owner review)

1. **Offers are recorded by the dispatch consumer, not by the driver-offers consumer** (spec §5 says the SNS→SQS consumer "records the offers"). Plan 1's `putOffers` records offers atomically, guarded by `offerSeq` and `MAX_OFFERS_PER_TRIP`, and every accept/cancel race test depends on it. Moving the write behind SNS would make offers eventually visible and reopen those races. SNS fan-out still carries each offer to the driver-offers queue, whose consumer is the hook for the Plan 2b push. Cost if wrong: one consumer changes owner of a write.
2. **Dispatch idempotency is "offer once per trip", not a dedup record.** A redelivered `trip.requested` must not offer the trip to 5 more drivers. `offerTripOnce` offers only while the trip has never been offered (`offerSeq` 0, the existing atomic guard); otherwise it returns the offers already recorded and the consumer re-publishes them (SNS is at-least-once anyway; the driver-offers consumer dedups by `offerId`). Billing and driver-offers use a dedup record written in the same transaction as their effect (spec wording).
3. **The "notifications" consumer of spec §5 moves to Plan 2b**, where its job (pushing to sockets) exists. This plan ships dispatch, driver-offers and billing.

## Review Focus

1. The same outbox event delivered twice (stream retry, SQS redelivery, duplicate SNS) → one billing record, one offer fan-out, one driver-offers dedup record.
2. `PutEvents` accepts some entries and rejects others → the publisher reports the first failed record so it and everything after it are retried; nothing is acknowledged that was not published.
3. A poison message (unparsable body, `schemaVersion` ≠ 1, missing `detail`) → only that message fails (partial batch response), the rest of the batch is acknowledged, and after 3 receives it lands in the DLQ.
4. A late `trip.requested` for a trip already accepted or cancelled → dispatch acknowledges it without offering (no error loop, no DLQ).
5. No AVAILABLE driver near the origin → the trip stays `REQUESTED` with no offers, the message is acknowledged, no SNS publish.

Tests: 1 → Tasks 5, 6; 2 → Task 3; 3 → Task 4; 4, 5 → Task 5.

## File Structure

```
src/context.ts                       # AsyncLocalStorage correlation id
src/events/envelope.ts               # zod schemas: TripEvent (v1), EventBridge envelope, DriverOffer (v1)
src/events/publisher.ts              # stream records → PutEvents entries; Lambda handler
src/events/sqs.ts                    # sqsHandler(): parse, per-record try/catch, batchItemFailures, logs
src/events/consumers/dispatch.ts     # trip.requested → offerTripOnce → SNS per offer
src/events/consumers/driver-offers.ts# DriverOffer → dedup record + log (Plan 2b pushes here)
src/events/consumers/billing.ts      # trip.completed → billing record + dedup in one transaction
src/infra/dynamo/consumed-repo.ts    # dedup items, shared by consumers
src/infra/dynamo/billing-repo.ts
infra/cdk/stateful-stack.ts          # + bus, rules, topic, subscription, queues, DLQs, outputs
scripts/build.ts                     # multi-entry bundle
scripts/dlq-demo.ts  scripts/redrive.ts
serverless.yml  Makefile  .github/workflows/ci.yml
docs/decisions/0004-event-delivery.md
tests/unit/events/**  tests/integration/consumers.test.ts  tests/e2e/trip-flow.test.ts
```

---

### Task 0: Floci spike for the event path

**Files:** Create `spike-events/` (throwaway, deleted at the end of the task), `docs/decisions/0004-event-delivery.md` (section "Floci spike").

Prove on Floci 2.4.0, with the AWS CLI in a throwaway venv as in ADR 0001, and record each result with its evidence line:
(a) SQS → Lambda event source mapping delivers, and `FunctionResponseTypes: ["ReportBatchItemFailures"]` re-delivers only the failed message;
(b) a queue with `RedrivePolicy` `maxReceiveCount: 3` moves a message that always fails to its DLQ;
(c) DynamoDB Streams → Lambda with `FilterCriteria` on `dynamodb.NewImage.entity.S = ["EVENT"]` (record whether the filter is honoured or ignored);
(d) SNS → SQS subscription with `RawMessageDelivery: true` delivers the raw JSON body;
(e) EventBridge rule (created by CDK) → SQS target with a queue policy allowing `events.amazonaws.com`;
(f) osls deploys two functions with `stream` and `sqs` events whose ARNs come from env vars.

- [ ] **Step 1:** Run probes (a)-(f); write the table in ADR 0004 (same format as ADR 0001).
- [ ] **Step 2: Decision rule.** If (a) or (b) fails: Task 7 adds the local queue adapter described there, and ADR 0004 says which parts are verified only by synthesis. If (c) filter is ignored: keep it in `serverless.yml` (real AWS honours it) and rely on the in-code filter of Task 3 (always present).
- [ ] **Step 3:** Delete `spike-events/`; commit `docs: ADR 0004 spike results for the event path`.

### Task 1: Correlation id travels into the outbox event

**Files:** Create `src/context.ts`; modify `src/domain/events.ts`, `src/infra/dynamo/trip-repo.ts` (`putOutbox`), `src/http/handler.ts`; tests `tests/unit/context.test.ts`, `tests/integration/trip-repo.test.ts`.

**Interfaces:**
- Produces: `runWithCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T>`; `currentCorrelationId(): string | undefined`; `TripEvent` gains optional `correlationId?: string`.

- [ ] **Step 1: Failing tests:** `currentCorrelationId()` is `undefined` outside a run and equals `'c-1'` inside `runWithCorrelation('c-1', …)`, including after an `await`; integration: a trip created inside `runWithCorrelation('c-2', …)` has an outbox item with `correlationId: 'c-2'`; created outside, the item has no `correlationId` attribute.
- [ ] **Step 2:** Implement with `node:async_hooks` `AsyncLocalStorage`; `putOutbox` spreads `correlationId` only when defined; the HTTP handler wraps the route call in `runWithCorrelation(correlationIdOf(event), …)`.
- [ ] **Step 3:** `npm run test:unit && npm run test:integration` pass; commit `feat(events): outbox events carry the request correlation id`.

### Task 2: Stateful event resources in CDK

**Files:** Modify `infra/cdk/stateful-stack.ts`, `infra/cdk/stateful-stack.test.ts`.

**Interfaces:**
- Produces CDK outputs (names fixed, read by the Makefile): `TableName`, `TableStreamArn`, `EventBusName`, `DispatchQueueArn`, `BillingQueueArn`, `DriverOffersQueueArn`, `DispatchDlqUrl`, `BillingDlqUrl`, `DriverOffersDlqUrl`, `DispatchQueueUrl`, `BillingQueueUrl`, `DriverOffersQueueUrl`, `OffersTopicArn`.

- [ ] **Step 1: Failing CDK assertions** (`Template.fromStack`): one `AWS::Events::EventBus` named `ridecore`; rule with pattern `{ source: ['ridecore.trips'], 'detail-type': ['trip.requested'] }` targeting the dispatch queue and one with `['trip.completed']` targeting billing; 6 queues with the names of Global Constraints; each main queue's `RedrivePolicy.maxReceiveCount` is 3 and `VisibilityTimeout` 60; DLQs `MessageRetentionPeriod` 1209600; SNS topic `ridecore-driver-offers` with an SQS subscription `RawMessageDelivery: true` to `ridecore-driver-offers`; every output above exists.
- [ ] **Step 2:** Implement with `aws-events`, `aws-events-targets.SqsQueue`, `aws-sqs`, `aws-sns`, `aws-sns-subscriptions.SqsSubscription({ rawMessageDelivery: true })` (these add the queue policies).
- [ ] **Step 3:** `npm run test:unit` and `npx cdk synth --quiet` pass; commit `feat(infra): event bus, rules, queues with DLQs and offers topic`.

### Task 3: Outbox publisher

**Files:** Create `src/events/envelope.ts`, `src/events/publisher.ts`; test `tests/unit/events/publisher.test.ts`.

**Interfaces:**
- Produces: `tripEventSchema` (zod, v1, `correlationId` optional); `EVENT_SOURCE = 'ridecore.trips'`; `outboxEntries(records: DynamoDBRecord[], busName: string): { sequenceNumber: string; entry: PutEventsRequestEntry }[]`; `createPublisher(deps: { send: (entries: PutEventsRequestEntry[]) => Promise<PutEventsResultEntry[]>; busName: string; log: Logger }): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>`; Lambda export `handler`.

- [ ] **Step 1: Failing tests:**
  - only `INSERT` records whose `NewImage.entity.S === 'EVENT'` become entries (a trip `META` modify, an `OFFER#` insert and an idempotency insert are skipped);
  - an entry has `Source: 'ridecore.trips'`, `DetailType` = the event `type`, `EventBusName` = busName, `Detail` = the event JSON **without** `PK`, `SK`, `entity` (unmarshalled with `@aws-sdk/util-dynamodb`);
  - entries are sent in chunks of at most 10 (`PutEvents` limit);
  - all accepted → `{ batchItemFailures: [] }`;
  - result entry 2 of 3 has `ErrorCode` → `batchItemFailures` = `[{ itemIdentifier: <sequenceNumber of record 2> }]` (first failure; the stream retries from it);
  - `send` throws → the handler rethrows (whole batch retried).
- [ ] **Step 2:** Implement; `handler` builds `send` from `EventBridgeClient` + `PutEventsCommand`, `busName` from `RIDECORE_EVENT_BUS`, logs one line per published event with its `correlationId`.
- [ ] **Step 3:** Tests pass; commit `feat(events): publish outbox events from the table stream to EventBridge`.

### Task 4: SQS consumer harness

**Files:** Create `src/events/sqs.ts`; test `tests/unit/events/sqs.test.ts`.

**Interfaces:**
- Consumes: `tripEventSchema` (Task 3).
- Produces: `fromEventBridge(body: string): TripEvent` (parses the EventBridge envelope and validates `detail`); `fromRaw<T>(schema: ZodType<T>): (body: string) => T`; `sqsHandler<T>(name: string, parse: (body: string) => T, handle: (message: T) => Promise<void>, log?: Logger): (event: SQSEvent) => Promise<SQSBatchResponse>`.

- [ ] **Step 1: Failing tests:** a batch of 3 where record 2 is not JSON → `batchItemFailures: [{ itemIdentifier: <messageId 2> }]` and records 1 and 3 were handled; `schemaVersion: 2` → that record fails; missing `detail` → fails; `handle` throwing for one record → only that one fails; every handled or failed record logs one line with `consumer: name`, `messageId` and the event's `correlationId` when present; an error line never includes the raw body.
- [ ] **Step 2:** Implement; records are handled sequentially (order within a batch is kept).
- [ ] **Step 3:** Tests pass; commit `feat(events): SQS consumer harness with partial batch failures`.

### Task 5: Dispatch and driver-offers consumers

**Files:** Modify `src/app/dispatch.ts`; create `src/infra/dynamo/consumed-repo.ts`, `src/events/consumers/dispatch.ts`, `src/events/consumers/driver-offers.ts`; extend `src/infra/dynamo/keys.ts`; tests `tests/integration/consumers.test.ts`, `tests/unit/events/dispatch-consumer.test.ts`.

**Interfaces:**
- Consumes: `createDispatch`, `OfferState`, `trips.getWithOffers`, `sqsHandler`, `fromEventBridge`, `fromRaw`.
- Produces:
  - `Dispatch.offerTripOnce(tripId: string, now?: Date): Promise<{ driverIds: string[]; fresh: boolean }>` — offers only when `offers.seq === 0`; if a concurrent call wins (`CONCURRENT_UPDATE`), re-reads and returns the recorded offers with `fresh: false`; a trip not `REQUESTED` returns `{ driverIds: [], fresh: false }` (no throw).
  - `driverOfferSchema` (in `envelope.ts`): `{ schemaVersion: 1, offerId: string /* `${tripId}:${driverId}` */, tripId, driverId, offeredAt: string, correlationId?: string }`.
  - `consumedKey(consumer: string, eventId: string) = { PK: 'CONSUMED#' + consumer, SK: 'EVENT#' + eventId }`, item TTL `expiresAt` = now + 7 days; `ConsumedRepo.putItem(consumer, eventId, now): TransactWriteItem` (condition `attribute_not_exists(PK)`) and `ConsumedRepo.markOnce(consumer, eventId, now): Promise<boolean>` (false when already there).
  - `createDispatchConsumer(deps: { dispatch: Dispatch; publish: (offer: DriverOffer) => Promise<void>; log: Logger })` and Lambda `handler` (`publish` via `SNSClient` + `PublishCommand` to `RIDECORE_OFFERS_TOPIC_ARN`).
  - `createDriverOffersConsumer(deps: { consumed: ConsumedRepo; log: Logger })` and Lambda `handler`.

- [ ] **Step 1: Failing integration tests (Floci table):** `offerTripOnce` on a fresh trip with 2 nearby drivers → `fresh: true`, 2 ids; called again → same ids, `fresh: false`, still 2 offers recorded; two concurrent calls → offers recorded once (≤ 5), both return the same ids; on a CANCELLED trip → `{ driverIds: [], fresh: false }` and no offer items; no drivers nearby → `{ driverIds: [], fresh: true }`, no offer items. `markOnce` twice with the same id → `true`, then `false`.
- [ ] **Step 2: Failing unit tests (fakes):** dispatch consumer publishes one `DriverOffer` per returned id with `offerId` `${tripId}:${driverId}` and the event's `correlationId`; with no ids it publishes nothing and succeeds; driver-offers consumer logs `offer received` once per `offerId` and `duplicate offer` on the second delivery.
- [ ] **Step 3:** Implement; dispatch consumer ignores any event type other than `trip.requested` (ack).
- [ ] **Step 4:** `npm run test:unit && npm run test:integration` pass; commit `feat(events): dispatch offers on trip.requested and fan them out through SNS`.

### Task 6: Billing consumer

**Files:** Create `src/infra/dynamo/billing-repo.ts`, `src/events/consumers/billing.ts`; extend `keys.ts`; tests in `tests/integration/consumers.test.ts`.

**Interfaces:**
- Produces: `billingKey(tripId) = { PK: 'TRIP#' + tripId, SK: 'BILLING' }`; billing item `{ entity: 'BILLING', tripId, passengerId, driverId, finalFare, completedAt, eventId }`; `BillingRepo.record(event: TripEvent, now: Date): Promise<'recorded' | 'duplicate'>` — one transaction: `ConsumedRepo.putItem('billing', eventId)` + billing Put (`attribute_not_exists(PK)`); a cancellation on the dedup condition → `'duplicate'`. `BillingRepo.get(tripId)`. `createBillingConsumer` + Lambda `handler`.

- [ ] **Step 1: Failing tests:** `record` of a `trip.completed` event → `'recorded'` and `get` returns `finalFare` from the payload; same event again → `'duplicate'`, one item; a `trip.completed` event missing `payload.finalFare` → throws (message goes to the DLQ path); the consumer acks any other event type.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Tests pass; commit `feat(events): billing record on trip.completed, idempotent per event`.

### Task 7: Build, deploy and wire on Floci

**Files:** Modify `scripts/build.ts`, `serverless.yml`, `Makefile`, `.github/workflows/ci.yml` (only if a new step is needed), `package.json` (new SDK clients as devDependencies for types and tests).

- [ ] **Step 1:** `build.ts` bundles 5 entries to `dist/`: `lambda.mjs` (API), `publisher.mjs`, `dispatch.mjs`, `driver-offers.mjs`, `billing.mjs`; `@aws-sdk/*` stays external.
- [ ] **Step 2:** `serverless.yml`: functions `publisher` (stream event on `${env:RIDECORE_TABLE_STREAM_ARN}`, `batchSize: 10`, `startingPosition: LATEST`, `maximumRetryAttempts: 10`, `bisectBatchOnFunctionError: true`, `functionResponseType: ReportBatchItemFailures`, filter pattern of Task 0 (c)); `dispatch`, `driverOffers`, `billing` (sqs events on the CDK queue ARNs, `batchSize: 10`, `functionResponseType: ReportBatchItemFailures`); env `RIDECORE_EVENT_BUS`, `RIDECORE_OFFERS_TOPIC_ARN`; IAM adds `events:PutEvents` on the bus and `sns:Publish` on the topic (the existing DynamoDB statements already cover the consumers' transactions; osls adds the stream and SQS read permissions for the triggers). No ARN defaults in `serverless.yml`; `make package` passes dummy ARNs so CI packaging needs no deploy.
- [ ] **Step 3:** `Makefile` `deploy-api` exports every Task 2 output from `cdk-outputs.json` before `serverless deploy`; `.env.deploy` also gets the queue and DLQ URLs (for e2e and the demo).
- [ ] **Step 4 (only if Task 0 (a) or (b) failed):** `src/local/consumers.ts` long-polls the three queues and calls the same exported handlers, deleting only acknowledged messages and leaving failed ones to SQS redrive; `make up` starts it in the background; ADR 0004 records it.
- [ ] **Step 5:** `make down && make up` succeeds from scratch; `make e2e` still passes; commit `feat(deploy): deploy the publisher and consumers to Floci`.

### Task 8: End to end through events, and the DLQ demo

**Files:** Modify `tests/e2e/trip-flow.test.ts`; create `scripts/dlq-demo.ts`, `scripts/redrive.ts`; Makefile targets `dlq-demo`, `redrive`.

**Interfaces:**
- Produces: `redrive(dlqUrl: string, queueUrl: string): Promise<number>` (receive → send body to the main queue → delete, until empty; returns moved count).

- [ ] **Step 1:** e2e: remove the direct `deps.dispatch.offerTrip` call. After `POST /trips`, the driver (AVAILABLE at the origin) polls `GET /drivers/me/offers` until the trip appears (every 1 s, fail after 30 s); after `complete`, poll the billing item (`BillingRepo.get`) until `finalFare` equals the trip's `finalFare` (30 s); assert the driver-offers dedup item `CONSUMED#driver-offers / EVENT#<tripId>:<driverId>` exists.
- [ ] **Step 2:** `scripts/dlq-demo.ts`: puts one `trip.completed` event with `schemaVersion: 99` on the bus, waits until the billing DLQ holds it (prints each receive count it sees, timeout 5 min), prints the DLQ depth; `make redrive QUEUE=billing` moves it back and prints the count. The README shows the output.
- [ ] **Step 3:** `make e2e` and `make e2e-local` pass; `make dlq-demo` ends with `billing DLQ: 1 message`; commit `test(e2e): trip flow through events; DLQ demo and redrive`.

### Task 9: Docs

**Files:** `docs/decisions/0004-event-delivery.md`, `README.md`.

- [ ] **Step 1:** ADR 0004 (after the spike section): outbox + Streams → EventBridge → SQS (why not publish from the request: lost events); SQS per consumer with DLQ and partial batch responses; SNS fan-out for offers; idempotency per consumer (dedup record in the same transaction; dispatch "offer once" and why); the stateful (CDK) / stateless (osls) split and the one-way outputs; the three rulings above; delivery guarantees in one line (at-least-once, ordered per trip by stream shard, consumers tolerate duplicates).
- [ ] **Step 2:** README: "What it does today" gains the event path; the diagram's "(Plan 2)" arrow becomes real; Roadmap item 1 moves to done; new "Watch an event fail and recover" section with `make dlq-demo` output. No claim the tests do not back.
- [ ] **Step 3:** Commit `docs: ADR 0004 event delivery; README event path and DLQ demo`.
