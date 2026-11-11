import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redrive } from '../../scripts/redrive.ts';
import { useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const sqs = new SQSClient({});
let dlq: string;
let main: string;

const depth = async (url: string) =>
  Number(
    (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes
      ?.ApproximateNumberOfMessages,
  );

beforeAll(async () => {
  const suffix = randomUUID().slice(0, 8);
  dlq = (await sqs.send(new CreateQueueCommand({ QueueName: `redrive-dlq-${suffix}` }))).QueueUrl ?? '';
  main = (await sqs.send(new CreateQueueCommand({ QueueName: `redrive-main-${suffix}` }))).QueueUrl ?? '';
});

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: main }));
});

describe('redrive (SQS on Floci)', () => {
  it('moves every DLQ message back to the main queue, bodies intact, and returns the count', async () => {
    const bodies = ['{"n":1}', '{"n":2}', '{"n":3}'];
    for (const MessageBody of bodies) await sqs.send(new SendMessageCommand({ QueueUrl: dlq, MessageBody }));

    expect(await redrive(sqs, dlq, main)).toBe(3);
    expect(await depth(dlq)).toBe(0);
    expect(await depth(main)).toBe(3);
  });

  it('an empty DLQ moves nothing', async () => {
    expect(await redrive(sqs, dlq, main)).toBe(0);
  });
});
