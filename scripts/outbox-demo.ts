import { DeleteRuleCommand, EventBridgeClient, PutRuleCommand, PutTargetsCommand, RemoveTargetsCommand } from '@aws-sdk/client-eventbridge';
import { GetEventSourceMappingCommand, LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from '@aws-sdk/client-lambda';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { EVENT_BUS_NAME, EVENT_SOURCE } from '../src/events/names.ts';
import { signToken } from '../src/http/auth.ts';

/**
 * Watch the outbox reconciler (ADR 0008, change 2) publish an event the stream never delivered:
 * the publisher's stream mapping is switched off, a trip is created, and its `trip.requested` reaches
 * the bus about a minute later through the scheduled reconciler. The mapping is always switched back
 * on, also after an error or Ctrl-C.
 */

/**
 * Runs `fn` with the stream disabled and enables it again afterwards. On SIGINT it aborts `fn`, waits
 * for it to settle (so `fn` removes what it created), enables the stream, then rejects with
 * "interrupted" so the caller can exit 130.
 */
export async function withStreamDisabled<T>(
  toggle: (enabled: boolean) => Promise<void>,
  fn: (signal: AbortSignal) => Promise<T>,
  signals: Pick<NodeJS.EventEmitter, 'once' | 'off'> = process,
): Promise<T> {
  const abort = new AbortController();
  const onSigint = () => abort.abort();
  signals.once('SIGINT', onSigint);
  await toggle(false);
  try {
    const result = await fn(abort.signal).catch((err: unknown) => {
      throw abort.signal.aborted ? new Error('interrupted') : err;
    });
    if (abort.signal.aborted) throw new Error('interrupted');
    return result;
  } finally {
    signals.off('SIGINT', onSigint);
    await toggle(true);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

async function main(): Promise<void> {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set: run 'make up' (writes .env.deploy)`);
    return value;
  };
  const api = env('RIDECORE_API_URL').replace(/\/$/, '');
  const secret = env('RIDECORE_JWT_SECRET');
  const busName = process.env.RIDECORE_EVENT_BUS ?? EVENT_BUS_NAME;
  const functionName = process.env.RIDECORE_PUBLISHER_FUNCTION ?? 'ridecore-dev-publisher';

  const lambda = new LambdaClient({});
  const events = new EventBridgeClient({});
  const sqs = new SQSClient({});

  const mapping = (await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: functionName }))).EventSourceMappings?.[0]?.UUID;
  if (mapping === undefined) throw new Error(`No stream mapping found for ${functionName}: run 'make up'`);
  const toggle = async (enabled: boolean) => {
    await lambda.send(new UpdateEventSourceMappingCommand({ UUID: mapping, Enabled: enabled }));
    const want = enabled ? 'Enabled' : 'Disabled';
    for (let i = 0; i < 60; i++) {
      const state = (await lambda.send(new GetEventSourceMappingCommand({ UUID: mapping }))).State;
      if (state === want) {
        console.log(`Stream to the publisher: ${want.toLowerCase()}.`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`The stream mapping did not become ${want}`);
  };

  const name = `outbox-demo-${randomUUID().slice(0, 8)}`;
  await withStreamDisabled(toggle, async (signal) => {
    let queueUrl: string | undefined;
    let ruleCreated = false;
    try {
      // The API generates the trip id, so the watch is set up first and filtered afterwards.
      queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl;
      const queueArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
      const ruleArn = (
        await events.send(
          new PutRuleCommand({
            Name: name,
            EventBusName: busName,
            EventPattern: JSON.stringify({ source: [EVENT_SOURCE], 'detail-type': ['trip.requested'] }),
            State: 'ENABLED',
          }),
        )
      ).RuleArn;
      ruleCreated = true;
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: queueUrl,
          Attributes: {
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn, Condition: { ArnEquals: { 'aws:SourceArn': ruleArn } } },
              ],
            }),
          },
        }),
      );
      await events.send(new PutTargetsCommand({ Rule: name, EventBusName: busName, Targets: [{ Id: 'demo', Arn: queueArn }] }));

      const passenger = { id: `outbox-demo-${randomUUID()}`, role: 'passenger' as const };
      const token = await signToken(passenger, secret);
      // Leticia (Amazonas): no demo, e2e or load driver is there, so the trip is not dispatched.
      const res = await fetch(`${api}/trips`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ origin: { lat: -4.2153, lng: -69.9406 }, destination: { lat: -4.2, lng: -69.93 } }),
      });
      if (res.status !== 201) throw new Error(`POST /trips answered ${res.status}: ${await res.text()}`);
      const trip = (await res.json()) as { id: string };
      const started = Date.now();
      console.log(`Created trip ${trip.id} at ${new Date(started).toISOString()}. Its trip.requested is in the outbox, marked pending.`);
      console.log('The stream is off, so only the reconciler (every minute, events older than 60 s) can publish it.');

      try {
        for (;;) {
          const elapsed = Math.round((Date.now() - started) / 1000);
          if (elapsed > 240) throw new Error('trip.requested did not reach the bus within 4 minutes');
          const got = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 10, MaxNumberOfMessages: 10 }), { abortSignal: signal });
          for (const m of got.Messages ?? []) {
            await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
            const detail = (JSON.parse(m.Body ?? '{}') as { detail?: { tripId?: string } }).detail;
            if (detail?.tripId === trip.id) {
              console.log(`trip.requested published by the reconciler after ${Math.round((Date.now() - started) / 1000)} s.`);
              return;
            }
          }
          console.log(`  t=${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s  waiting for trip.requested on the bus`);
          await sleep(0, signal);
        }
      } finally {
        await fetch(`${api}/trips/${trip.id}/cancel`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'outbox demo' }),
        }).catch(() => undefined);
      }
    } finally {
      if (ruleCreated) {
        await events.send(new RemoveTargetsCommand({ Rule: name, EventBusName: busName, Ids: ['demo'] })).catch(() => undefined);
        await events.send(new DeleteRuleCommand({ Name: name, EventBusName: busName })).catch(() => undefined);
      }
      if (queueUrl !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
      console.log('Removed the temporary rule and queue.');
    }
  });
}

if (process.argv[1]?.endsWith('outbox-demo.ts')) {
  main().catch((err: unknown) => {
    const message = (err as Error).message;
    console.error(message);
    process.exit(message === 'interrupted' ? 130 : 1);
  });
}
