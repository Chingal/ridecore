import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createDispatchConsumer } from '../../../src/events/consumers/dispatch.ts';
import { createDriverOffersConsumer } from '../../../src/events/consumers/driver-offers.ts';
import type { DriverOffer } from '../../../src/events/envelope.ts';
import type { Actor } from '../../../src/domain/trip.ts';
import type { LogLine } from '../../../src/log.ts';
import type { ServerMessage } from '../../../src/realtime/messages.ts';

const NOW = new Date('2026-11-10T12:00:00.000Z');

const tripEvent = (type: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  eventId: 't1:1',
  type,
  tripId: 't1',
  version: 1,
  occurredAt: NOW.toISOString(),
  payload: {},
  ...extra,
});
const fromBus = (detail: unknown) => JSON.stringify({ source: 'ridecore.trips', 'detail-type': 'x', detail });
const sqs = (bodies: string[]): SQSEvent => ({ Records: bodies.map((body, i) => ({ messageId: `m${i + 1}`, body }) as SQSRecord) });

describe('dispatch consumer', () => {
  function setup(result: { driverIds: string[]; fresh: boolean }) {
    const offered: string[] = [];
    const published: DriverOffer[] = [];
    const consumer = createDispatchConsumer({
      dispatch: {
        offerTripOnce: (tripId) => {
          offered.push(tripId);
          return Promise.resolve(result);
        },
      },
      publish: (offer) => {
        published.push(offer);
        return Promise.resolve();
      },
      log: () => undefined,
      now: () => NOW,
    });
    return { consumer, offered, published };
  }

  it('publishes one DriverOffer per offered driver, with the event correlation id', async () => {
    const { consumer, published } = setup({ driverIds: ['d1', 'd2'], fresh: true });
    const res = await consumer(sqs([fromBus(tripEvent('trip.requested', { correlationId: 'c-7' }))]));
    expect(res).toEqual({ batchItemFailures: [] });
    expect(published).toEqual([
      { schemaVersion: 1, offerId: 't1:d1', tripId: 't1', driverId: 'd1', offeredAt: NOW.toISOString(), correlationId: 'c-7' },
      { schemaVersion: 1, offerId: 't1:d2', tripId: 't1', driverId: 'd2', offeredAt: NOW.toISOString(), correlationId: 'c-7' },
    ]);
  });

  it('re-publishes the recorded offers on a redelivery (fresh: false), so a lost publish is recovered', async () => {
    const { consumer, published } = setup({ driverIds: ['d1'], fresh: false });
    await consumer(sqs([fromBus(tripEvent('trip.requested'))]));
    expect(published.map((o) => o.offerId)).toEqual(['t1:d1']);
  });

  it('with no driver offered it publishes nothing and succeeds', async () => {
    const { consumer, published } = setup({ driverIds: [], fresh: true });
    expect(await consumer(sqs([fromBus(tripEvent('trip.requested'))]))).toEqual({ batchItemFailures: [] });
    expect(published).toEqual([]);
  });

  it('acknowledges any other event type without dispatching', async () => {
    const { consumer, offered } = setup({ driverIds: ['d1'], fresh: true });
    expect(await consumer(sqs([fromBus(tripEvent('trip.completed'))]))).toEqual({ batchItemFailures: [] });
    expect(offered).toEqual([]);
  });
});

describe('driver-offers consumer', () => {
  const offerOf = (driverId = 'd1') =>
    JSON.stringify({ schemaVersion: 1, offerId: `t1:${driverId}`, tripId: 't1', driverId, offeredAt: NOW.toISOString(), correlationId: 'c-1' });

  function setup(outcome: 'sent' | 'gone' | Error = 'sent', sockets: string[] = ['dc']) {
    const marked = new Set<string>();
    const logs: LogLine[] = [];
    const pushed: [string, ServerMessage][] = [];
    const consumer = createDriverOffersConsumer({
      consumed: {
        has: (consumer, eventId) => Promise.resolve(marked.has(`${consumer}/${eventId}`)),
        markOnce: (consumer, eventId) => {
          const key = `${consumer}/${eventId}`;
          const first = !marked.has(key);
          marked.add(key);
          return Promise.resolve(first);
        },
      },
      connections: { byActor: async (a: Actor) => (a.role === 'driver' && a.id === 'd1' ? sockets : []), remove: async () => undefined },
      pusher: {
        send: async (id, m) => {
          if (outcome instanceof Error) throw outcome;
          if (outcome === 'sent') pushed.push([id, m]);
          return outcome;
        },
      },
      log: (line) => logs.push(line),
      now: () => NOW,
    });
    return { consumer, marked, logs, pushed };
  }

  it("pushes the first delivery of an offer to the driver's sockets and marks it; a duplicate is not pushed", async () => {
    const { consumer, marked, logs, pushed } = setup();
    expect(await consumer(sqs([offerOf(), offerOf()]))).toEqual({ batchItemFailures: [] });
    expect(marked).toEqual(new Set(['driver-offers/t1:d1']));
    expect(pushed).toEqual([['dc', { type: 'offer', schemaVersion: 1, offer: { offerId: 't1:d1', tripId: 't1', offeredAt: NOW.toISOString() } }]]);
    expect(logs.filter((l) => l.msg === 'offer received')).toHaveLength(1);
    expect(logs.filter((l) => l.msg === 'duplicate offer')).toHaveLength(1);
  });

  it('leaves the offer unmarked when the push fails, so the retry pushes it', async () => {
    const { consumer, marked } = setup(Object.assign(new Error('boom'), { name: 'InternalServerError' }));
    expect(await consumer(sqs([offerOf()]))).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(marked.size).toBe(0);
  });

  it('marks an offer for a driver with no open socket', async () => {
    const { consumer, marked, pushed } = setup('sent', []);
    expect(await consumer(sqs([offerOf()]))).toEqual({ batchItemFailures: [] });
    expect(marked.size).toBe(1);
    expect(pushed).toEqual([]);
  });

  it('rejects a body that is not a DriverOffer v1', async () => {
    const { consumer } = setup();
    expect(await consumer(sqs(['{"schemaVersion":2}']))).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });
});
