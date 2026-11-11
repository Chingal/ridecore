import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../../../src/domain/trip.ts';
import { createNotifierConsumer } from '../../../src/events/consumers/notifier.ts';
import type { ServerMessage } from '../../../src/realtime/messages.ts';

const NOW = '2026-11-11T12:00:00.000Z';
const event = (type: string, version: number, payload: Record<string, unknown>) => ({
  schemaVersion: 1,
  eventId: `t1:${version}`,
  type,
  tripId: 't1',
  version,
  occurredAt: NOW,
  payload,
  correlationId: 'corr-1',
});
const sqs = (details: unknown[]): SQSEvent => ({
  Records: details.map((detail, i) => ({ messageId: `m${i + 1}`, body: JSON.stringify({ source: 'ridecore.trips', detail }) }) as SQSRecord),
});

function setup(sockets: Record<string, string[]>, outcome: Record<string, 'sent' | 'gone' | Error> = {}) {
  const sent: [string, ServerMessage][] = [];
  const removed: string[] = [];
  const consumer = createNotifierConsumer({
    connections: {
      byActor: async (a: Actor) => sockets[`${a.role}:${a.id}`] ?? [],
      remove: async (id) => void removed.push(id),
    },
    pusher: {
      send: async (id, m) => {
        const o = outcome[id] ?? 'sent';
        if (o instanceof Error) throw o;
        if (o === 'sent') sent.push([id, m]);
        return o;
      },
    },
    log: () => undefined,
  });
  return { consumer, sent, removed };
}

describe('notifier consumer', () => {
  it("pushes a trip event to the passenger's and the driver's sockets, with version and eventId but no correlation id", async () => {
    const { consumer, sent } = setup({ 'passenger:p1': ['pc'], 'driver:d1': ['dc1', 'dc2'] });
    const res = await consumer(sqs([event('trip.accepted', 2, { passengerId: 'p1', driverId: 'd1', toState: 'ACCEPTED' })]));

    expect(res.batchItemFailures).toEqual([]);
    expect(sent.map(([id]) => id).sort()).toEqual(['dc1', 'dc2', 'pc']);
    const [, message] = sent[0] ?? [];
    expect(message).toEqual({
      type: 'trip',
      schemaVersion: 1,
      event: { eventId: 't1:2', type: 'trip.accepted', tripId: 't1', version: 2, occurredAt: NOW, payload: { passengerId: 'p1', driverId: 'd1', toState: 'ACCEPTED' } },
    });
    expect(JSON.stringify(sent)).not.toContain('corr-1');
  });

  it('pushes trip.requested (no driver yet) to the passenger only', async () => {
    const { consumer, sent } = setup({ 'passenger:p1': ['pc'], 'driver:d1': ['dc'] });
    await consumer(sqs([event('trip.requested', 1, { passengerId: 'p1' })]));
    expect(sent.map(([id]) => id)).toEqual(['pc']);
  });

  it('acks when nobody is connected, and removes gone sockets without failing', async () => {
    const quiet = setup({});
    expect((await quiet.consumer(sqs([event('trip.started', 4, { passengerId: 'p1', driverId: 'd1' })]))).batchItemFailures).toEqual([]);

    const gone = setup({ 'passenger:p1': ['pc'] }, { pc: 'gone' });
    expect((await gone.consumer(sqs([event('trip.started', 4, { passengerId: 'p1' })]))).batchItemFailures).toEqual([]);
    expect(gone.removed).toEqual(['pc']);
  });

  it('fails the record when a push fails for another reason, so SQS retries it', async () => {
    const { consumer } = setup({ 'passenger:p1': ['pc'] }, { pc: Object.assign(new Error('boom'), { name: 'InternalServerError' }) });
    const res = await consumer(sqs([event('trip.started', 4, { passengerId: 'p1' }), event('trip.started', 4, { passengerId: 'p2' })]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('rejects an event without a passenger id', async () => {
    const { consumer } = setup({});
    expect((await consumer(sqs([event('trip.started', 4, {})]))).batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});
