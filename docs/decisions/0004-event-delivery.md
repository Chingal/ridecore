# ADR 0004: Event delivery

Date: 2026-11-10. Status: accepted.

## Floci spike

Before building the event path (Plan 2a) we checked every piece on Floci 2.4.0 (`ridecore-floci-1`, port 4567), with AWS CLI 1.46.3 in a throwaway venv and dummy credentials. A tiny Node 24 Lambda logged each record and failed any record whose body contained `fail`.

| Check | Result | Evidence |
|---|---|---|
| (a) SQS → Lambda with `ReportBatchItemFailures` | **Pass** | Batch `ok-1, fail-2, ok-3`: first receive logged all three (`ApproximateReceiveCount` 1); only `fail-2` came back (counts 2 and 3) |
| (b) Redrive to DLQ, `maxReceiveCount: 3` | **Pass** | After the third receive the DLQ held 1 message (≈ 20 s with a 5 s visibility timeout); `receive-message` on the DLQ returned `fail-2` |
| (c) Streams → Lambda with `FilterCriteria` | **Pass, filter honoured** | Pattern `{"eventName":["INSERT"],"dynamodb":{"NewImage":{"entity":{"S":["EVENT"]}}}}`; of an EVENT insert, a TRIP insert and an EVENT modify, the Lambda saw only the EVENT insert |
| (d) SNS → SQS, `RawMessageDelivery: true` | **Pass** | Queue body was exactly the published JSON `{"offerId":"t1:d1"}`, no SNS envelope |
| (e) EventBridge custom bus rule → SQS | **Pass** | Rule on `source: ridecore.trips`, `detail-type: trip.requested`; of a `trip.requested` and a `trip.completed` put, only the first reached the queue. Body is the full envelope (`version`, `id`, `source`, `detail-type`, `time`, `detail`, plus `event-bus-name`) |
| (f) osls deploys `stream` and `sqs` events from env ARNs | **Pass** | `Service deployed to stack spk-sls-dev (10s)`; both mappings `Enabled` with `ReportBatchItemFailures`; the stream mapping kept the filter pattern |
| (g) SDK packages in `public.ecr.aws/lambda/nodejs:24` | **Pass** | `/var/runtime/node_modules/@aws-sdk` has `client-eventbridge`, `client-sns`, `client-sqs`, `util-dynamodb`, `client-dynamodb`, `lib-dynamodb` (and `client-apigatewaymanagementapi` for Plan 2b) |

Consequences: no local queue adapter is needed (Plan 2a Task 7 Step 4 is skipped); the SDK clients stay external to the bundle; the stream filter is kept in `serverless.yml` and the publisher still filters in code, so a mapping without the filter cannot publish non-outbox items.

## Context

Every trip state change already writes the trip and its `TripEvent` in one DynamoDB transaction (the outbox item, `entity: 'EVENT'`). Plan 2a delivers those events to consumers that react asynchronously: offering a requested trip to nearby drivers, recording the fare of a completed trip, and (Plan 2b) pushing updates to sockets.

## Decision

**Outbox → stream → EventBridge.** A publisher Lambda reads the table stream, keeps only outbox INSERTs (stream filter, and again in code) and puts them on the `ridecore` bus (`source: ridecore.trips`, `detail-type` = event type). Publishing from the HTTP request instead would lose the event whenever the request dies between the write and the publish; the outbox makes "state saved" and "event will be delivered" the same write. PutEvents calls hold at most 10 entries and never two events of the same trip, so when EventBridge rejects one entry the stream retries from it without a later event of that trip having overtaken it.

**One SQS queue per consumer, each with a DLQ.** Rules route `trip.requested` to `ridecore-dispatch` and `trip.completed` to `ridecore-billing`. Consumers return partial batch failures, so one bad message never blocks the rest of its batch; after 3 receives (60 s visibility, 6 × the Lambda timeout) it moves to the queue's DLQ (14-day retention). `make dlq-demo` shows it and `make redrive QUEUE=…` moves messages back after a fix.

**SNS fan-out for offers.** The dispatch consumer publishes one message per offered driver to `ridecore-driver-offers`; the topic delivers raw JSON to the `ridecore-driver-offers` queue, whose consumer is where Plan 2b pushes the offer to the driver's socket. More subscribers (a push-notification service, analytics) can join without touching dispatch.

**Idempotent consumers.** Delivery is at-least-once everywhere (stream retries, SQS redelivery, SNS), so:
- billing writes the billing record and a dedup record (`CONSUMED#billing / EVENT#<eventId>`, 7-day TTL) in ONE transaction; a failed condition means "already applied";
- driver-offers records each `offerId` the same way (`CONSUMED#driver-offers`);
- dispatch offers a trip **once**: it writes offers only while the trip has never been offered (the existing atomic `offerSeq` guard). A redelivery returns the recorded offers and publishes them again (recovering a publish lost after the write); a trip already accepted or cancelled is acknowledged without offering.

**Stateful vs stateless.** CDK owns everything that holds data or routes it (table, bus, rules, topic, subscription, queues, DLQs and their policies). osls owns the functions and their stream and SQS triggers. osls reads the CDK outputs through `scripts/cdk-env.ts` (the Makefile exports them); CDK never reads from osls, so there is no circular dependency, and a function deploy can never delete a queue holding messages.

**Rulings on the design spec** (owner-approved 2026-11-10):
1. Offers are recorded by the dispatch consumer, not by the SNS→SQS consumer: the offer write is atomic with its race guards (accept vs accept, accept vs cancel); moving it behind SNS would make offers eventually visible and reopen those races.
2. Dispatch idempotency is "offer once per trip" (above), not a dedup record.
3. The notifications consumer moves to Plan 2b, where pushing to sockets exists.

## Guarantees

At-least-once delivery; consumers tolerate duplicates. Order is kept per trip from the stream to EventBridge (stream shard order plus the per-trip chunking above); SQS standard queues do not guarantee order, so consumers check state instead of trusting arrival order (dispatch ignores a `trip.requested` for a trip that is no longer `REQUESTED`).

## Consequences

- Correlation ids flow from the HTTP request into the outbox item and every consumer log line of a message it could parse (`x-correlation-id` → `correlationId`).
- e2e covers the full path on Floci: the driver receives the offer only through the dispatch consumer, and the billing record appears only through the billing consumer.
- A trip with no driver nearby stays `REQUESTED` with no offers until it is cancelled; a redelivery may offer it to drivers who came online later (no expiry or re-offer timer yet).
