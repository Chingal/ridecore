import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LogLine } from '../../../src/log.ts';
import { fromEventBridge, fromRaw, sqsHandler } from '../../../src/events/sqs.ts';

const tripEvent = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventId: 't1:2',
  type: 'trip.completed',
  tripId: 't1',
  version: 2,
  occurredAt: '2026-11-10T12:00:00.000Z',
  payload: { finalFare: 9000 },
  ...extra,
});

const envelope = (detail: unknown) =>
  JSON.stringify({ version: '0', id: 'x', source: 'ridecore.trips', 'detail-type': 'trip.completed', detail });

const sqs = (bodies: string[]): SQSEvent => ({
  Records: bodies.map((body, i) => ({ messageId: `m${i + 1}`, body }) as SQSRecord),
});

describe('fromEventBridge', () => {
  it('returns the validated detail of an EventBridge envelope', () => {
    expect(fromEventBridge(envelope(tripEvent({ correlationId: 'c-9' })))).toEqual(tripEvent({ correlationId: 'c-9' }));
  });

  it('rejects an unknown schema version, a missing detail and a body that is not JSON', () => {
    expect(() => fromEventBridge(envelope(tripEvent({ schemaVersion: 2 })))).toThrow();
    expect(() => fromEventBridge(JSON.stringify({ source: 'ridecore.trips' }))).toThrow();
    expect(() => fromEventBridge('not json')).toThrow();
  });
});

describe('fromRaw', () => {
  it('validates a raw JSON body with the given schema', () => {
    const parse = fromRaw(z.object({ a: z.number() }));
    expect(parse('{"a":1}')).toEqual({ a: 1 });
    expect(() => parse('{"a":"x"}')).toThrow();
  });
});

describe('sqsHandler', () => {
  function setup(fail: (message: { eventId: string }) => boolean = () => false) {
    const handled: string[] = [];
    const logs: LogLine[] = [];
    const handler = sqsHandler(
      'billing',
      fromEventBridge,
      async (message) => {
        if (fail(message)) throw new Error('boom');
        handled.push(message.eventId);
      },
      (line) => logs.push(line),
    );
    return { handler, handled, logs };
  }

  it('reports only the record that cannot be parsed; the others are handled, in order', async () => {
    const { handler, handled } = setup();
    const res = await handler(sqs([envelope(tripEvent({ eventId: 'a' })), 'not json', envelope(tripEvent({ eventId: 'c' }))]));
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(handled).toEqual(['a', 'c']);
  });

  it('reports a record whose schema version is unknown or whose detail is missing', async () => {
    const { handler } = setup();
    const res = await handler(sqs([envelope(tripEvent({ schemaVersion: 2 })), JSON.stringify({ source: 'x' })]));
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
  });

  it('reports only the record whose handling throws', async () => {
    const { handler, handled } = setup((m) => m.eventId === 'b');
    const res = await handler(sqs(['a', 'b', 'c'].map((eventId) => envelope(tripEvent({ eventId })))));
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(handled).toEqual(['a', 'c']);
  });

  it('logs one line per record with consumer, messageId and correlationId; never the raw body', async () => {
    const { handler, logs } = setup((m) => m.eventId === 'b');
    const secret = 'SECRET-BODY-CONTENT';
    await handler(
      sqs([envelope(tripEvent({ eventId: 'a', correlationId: 'c-1' })), envelope(tripEvent({ eventId: 'b', correlationId: 'c-2' })), secret]),
    );
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ level: 'info', consumer: 'billing', messageId: 'm1', correlationId: 'c-1' });
    expect(logs[1]).toMatchObject({ level: 'error', consumer: 'billing', messageId: 'm2', correlationId: 'c-2', error: 'boom' });
    expect(logs[2]).toMatchObject({ level: 'error', consumer: 'billing', messageId: 'm3' });
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});
