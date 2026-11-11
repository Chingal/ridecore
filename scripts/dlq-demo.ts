import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS_NAME, EVENT_SOURCE } from '../src/events/names.ts';

/**
 * Watch an event fail and land in a DLQ (ADR 0004): puts a `trip.completed` event with an unknown
 * `schemaVersion` (99) on the bus. The billing consumer rejects it on every receive; after 3 receives
 * (60 s visibility timeout each) SQS moves it to `ridecore-billing-dlq`. Then `make redrive
 * QUEUE=billing` moves it back (in real life, after deploying a fix).
 */
const busName = process.env.RIDECORE_EVENT_BUS ?? EVENT_BUS_NAME;
const dlqUrl = process.env.RIDECORE_BILLING_DLQ_URL;
const queueUrl = process.env.RIDECORE_BILLING_QUEUE_URL;
if (dlqUrl === undefined || queueUrl === undefined) {
  console.error("Queue URLs not set: run 'make up' (writes .env.deploy)");
  process.exit(1);
}

const sqs = new SQSClient({});
const attrs = async (url: string) =>
  (
    await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
    )
  ).Attributes ?? {};
const visible = async (url: string) => Number((await attrs(url)).ApproximateNumberOfMessages ?? 0);

const before = await visible(dlqUrl);
const tripId = randomUUID();
const poison = {
  schemaVersion: 99,
  eventId: `${tripId}:5`,
  type: 'trip.completed',
  tripId,
  version: 5,
  occurredAt: new Date().toISOString(),
  payload: { finalFare: 7200 },
  correlationId: `dlq-demo-${tripId.slice(0, 8)}`,
};
const put = await new EventBridgeClient({}).send(
  new PutEventsCommand({ Entries: [{ Source: EVENT_SOURCE, DetailType: 'trip.completed', EventBusName: busName, Detail: JSON.stringify(poison) }] }),
);
if ((put.FailedEntryCount ?? 0) > 0) throw new Error(`PutEvents rejected the demo event: ${JSON.stringify(put.Entries)}`);
console.log(`Put trip.completed with schemaVersion 99 (correlationId ${poison.correlationId}) on bus ${busName}.`);
console.log('The billing consumer rejects it on each receive; SQS retries it every 60 s, 3 receives in total.');

const started = Date.now();
const deadline = started + 5 * 60_000;
for (;;) {
  const now = await visible(dlqUrl);
  const main = await attrs(queueUrl);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`  t=${String(elapsed).padStart(3)}s  billing in flight: ${main.ApproximateNumberOfMessagesNotVisible ?? 0}  billing DLQ: ${now}`);
  if (now > before) {
    console.log(`billing DLQ: ${now} message(s). Move it back with: make redrive QUEUE=billing`);
    break;
  }
  if (Date.now() > deadline) throw new Error('The demo event did not reach the billing DLQ within 5 minutes');
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
