import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/**
 * Moves every message of a DLQ back to its main queue (receive → send → delete, until a receive
 * comes back empty) and returns how many it moved. A message is deleted from the DLQ only after
 * the send succeeded, so a crash midway duplicates at most one message, never loses one.
 *
 *   make redrive QUEUE=billing      # or dispatch / driver-offers / notifications (URLs from .env.deploy)
 */
export async function redrive(sqs: Pick<SQSClient, 'send'>, dlqUrl: string, queueUrl: string): Promise<number> {
  let moved = 0;
  for (;;) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const messages = res.Messages ?? [];
    if (messages.length === 0) return moved;
    for (const message of messages) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: message.Body ?? '' }));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }));
      moved += 1;
    }
  }
}

const QUEUES = { dispatch: 'DISPATCH', billing: 'BILLING', 'driver-offers': 'DRIVER_OFFERS', notifications: 'NOTIFICATIONS' } as const;

if (import.meta.main) {
  const name = process.argv[2] as keyof typeof QUEUES | undefined;
  const key = name === undefined ? undefined : QUEUES[name];
  if (key === undefined) {
    console.error(`Usage: node scripts/redrive.ts <${Object.keys(QUEUES).join('|')}>`);
    process.exit(1);
  }
  const dlq = process.env[`RIDECORE_${key}_DLQ_URL`];
  const main = process.env[`RIDECORE_${key}_QUEUE_URL`];
  if (dlq === undefined || main === undefined) {
    console.error("Queue URLs not set: run 'make up' (writes .env.deploy)");
    process.exit(1);
  }
  const moved = await redrive(new SQSClient({}), dlq, main);
  console.log(`Moved ${moved} message(s) from ${name}-dlq back to ${name}.`);
}
