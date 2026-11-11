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
