import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createDispatchConsumer } from '../../../src/events/consumers/dispatch.ts';
import { createDriverOffersConsumer } from '../../../src/events/consumers/driver-offers.ts';
import type { DriverOffer } from '../../../src/events/envelope.ts';
import type { LogLine } from '../../../src/log.ts';

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
  it('logs the first delivery of an offer and flags later ones as duplicates', async () => {
    const seen = new Set<string>();
    const logs: LogLine[] = [];
    const consumer = createDriverOffersConsumer({
      consumed: {
        markOnce: (consumer, eventId) => {
          const key = `${consumer}/${eventId}`;
          const first = !seen.has(key);
          seen.add(key);
          return Promise.resolve(first);
        },
      },
      log: (line) => logs.push(line),
      now: () => NOW,
    });
    const offer = JSON.stringify({ schemaVersion: 1, offerId: 't1:d1', tripId: 't1', driverId: 'd1', offeredAt: NOW.toISOString() });

    expect(await consumer(sqs([offer, offer]))).toEqual({ batchItemFailures: [] });
    expect(seen).toEqual(new Set(['driver-offers/t1:d1']));
    expect(logs.filter((l) => l.msg === 'offer received')).toHaveLength(1);
    expect(logs.filter((l) => l.msg === 'duplicate offer')).toHaveLength(1);
  });

  it('rejects a body that is not a DriverOffer v1', async () => {
    const consumer = createDriverOffersConsumer({ consumed: { markOnce: () => Promise.resolve(true) }, log: () => undefined });
    expect(await consumer(sqs(['{"schemaVersion":2}']))).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
  });
});
