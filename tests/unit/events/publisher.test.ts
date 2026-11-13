import type { PutEventsRequestEntry, PutEventsResultEntry } from '@aws-sdk/client-eventbridge';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createPublisher, EVENT_SOURCE, outboxEntries } from '../../../src/events/publisher.ts';

const BUS = 'ridecore';

function event(tripId: string, version: number, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: `${tripId}:${version}`,
    type: 'trip.requested',
    tripId,
    version,
    occurredAt: '2026-11-10T12:00:00.000Z',
    payload: { fromState: null, toState: 'REQUESTED', passengerId: 'p-1', fareEstimate: 7000 },
    ...extra,
  };
}

function record(seq: string, eventName: 'INSERT' | 'MODIFY' | 'REMOVE', image: Record<string, unknown>): DynamoDBRecord {
  return {
    eventName,
    dynamodb: {
      SequenceNumber: seq,
      NewImage: marshall(image, { removeUndefinedValues: true }) as NonNullable<DynamoDBRecord['dynamodb']>['NewImage'],
    },
  };
}

const outbox = (seq: string, tripId: string, version: number, extra: Record<string, unknown> = {}) =>
  record(seq, 'INSERT', {
    ...event(tripId, version, extra),
    PK: `TRIP#${tripId}`,
    SK: `EVENT#${String(version).padStart(6, '0')}`,
    entity: 'EVENT',
  });

describe('outboxEntries', () => {
  it('keeps only outbox INSERTs; trip updates, offers and idempotency items are skipped', () => {
    const records = [
      record('1', 'MODIFY', { PK: 'TRIP#t1', SK: 'META', entity: 'TRIP' }),
      outbox('2', 't1', 1),
      record('3', 'INSERT', { PK: 'TRIP#t1', SK: 'OFFER#d1', entity: 'OFFER' }),
      record('4', 'INSERT', { PK: 'IDEM#passenger#p#k', SK: 'META', entity: 'IDEMPOTENCY' }),
      record('5', 'MODIFY', { ...event('t1', 1), PK: 'TRIP#t1', SK: 'EVENT#000001', entity: 'EVENT' }),
    ];
    expect(outboxEntries(records, BUS).map((e) => e.sequenceNumber)).toEqual(['2']);
  });

  it('builds the EventBridge entry: source, detail type, bus and the event without storage keys', () => {
    const [entry] = outboxEntries([outbox('9', 't1', 1, { correlationId: 'c-1' })], BUS);
    expect(entry?.entry).toMatchObject({ Source: EVENT_SOURCE, DetailType: 'trip.requested', EventBusName: BUS });
    expect(EVENT_SOURCE).toBe('ridecore.trips');
    expect(JSON.parse(String(entry?.entry.Detail))).toEqual(event('t1', 1, { correlationId: 'c-1' }));
  });
});

describe('publisher handler', () => {
  const log = () => undefined;
  const noStore = { clear: () => Promise.resolve(), now: () => new Date('2026-11-13T12:00:00.000Z') };

  function fakeBus(results: (entries: PutEventsRequestEntry[]) => PutEventsResultEntry[]) {
    const calls: PutEventsRequestEntry[][] = [];
    const send = (entries: PutEventsRequestEntry[]) => {
      calls.push(entries);
      return Promise.resolve(results(entries));
    };
    return { calls, send };
  }
  const ok = (entries: PutEventsRequestEntry[]) => entries.map(() => ({ EventId: 'e' }));

  it('sends at most 10 entries per PutEvents call', async () => {
    const bus = fakeBus(ok);
    const records = Array.from({ length: 23 }, (_, i) => outbox(String(i + 1), `t${i}`, 1));
    const res = await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: records });
    expect(bus.calls.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(res).toEqual({ batchItemFailures: [] });
  });

  it('reports the first rejected record so the stream retries from it', async () => {
    const bus = fakeBus((entries) => entries.map((_, i) => (i === 1 ? { ErrorCode: 'InternalFailure', ErrorMessage: 'x' } : { EventId: 'e' })));
    const records = [outbox('11', 'a', 1), outbox('12', 'b', 1), outbox('13', 'c', 1)];
    const res = await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: records });
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '12' }] });
  });

  it('stops at the first failing chunk: later chunks are not sent, the failure is the chunk start', async () => {
    let n = 0;
    const bus = fakeBus((entries) => (n++ === 0 ? entries.map(() => ({ ErrorCode: 'Throttling' })) : ok(entries)));
    const records = Array.from({ length: 12 }, (_, i) => outbox(String(100 + i), `t${i}`, 1));
    const res = await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: records });
    expect(bus.calls).toHaveLength(1);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '100' }] });
  });

  it('never puts two events of the same trip in one PutEvents call, so a retry keeps per-trip order', async () => {
    const bus = fakeBus(ok);
    const records = [outbox('1', 'a', 1), outbox('2', 'b', 1), outbox('3', 'a', 2), outbox('4', 'a', 3), outbox('5', 'c', 1)];
    await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: records });
    const tripsPerCall = bus.calls.map((c) => c.map((e) => (JSON.parse(String(e.Detail)) as { tripId: string }).tripId));
    expect(tripsPerCall).toEqual([['a', 'b'], ['a'], ['a', 'c']]);
  });

  it('a failed event of a trip is retried before any later event of the same trip is sent', async () => {
    const bus = fakeBus((entries) => entries.map((e) => (String(e.Detail).includes('"a:1"') ? { ErrorCode: 'InternalFailure' } : { EventId: 'e' })));
    const res = await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: [outbox('1', 'a', 1), outbox('2', 'a', 2)] });
    expect(bus.calls.flat().map((e) => (JSON.parse(String(e.Detail)) as { eventId: string }).eventId)).toEqual(['a:1']);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
  });

  it('an INSERT without a new image is a configuration error, not a skip', async () => {
    const bus = fakeBus(ok);
    const broken: DynamoDBRecord = { eventName: 'INSERT', dynamodb: { SequenceNumber: '7' } };
    await expect(createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({ Records: [broken] })).rejects.toThrow(/NewImage/);
  });

  it('rethrows when PutEvents itself fails (the whole batch is retried)', async () => {
    const send = () => Promise.reject(new Error('network down'));
    await expect(createPublisher({ send, busName: BUS, log, ...noStore })({ Records: [outbox('1', 't', 1)] })).rejects.toThrow('network down');
  });

  it('a batch with no outbox records publishes nothing', async () => {
    const bus = fakeBus(ok);
    const res = await createPublisher({ send: bus.send, busName: BUS, log, ...noStore })({
      Records: [record('1', 'MODIFY', { PK: 'TRIP#t', SK: 'META', entity: 'TRIP' })],
    });
    expect(bus.calls).toHaveLength(0);
    expect(res).toEqual({ batchItemFailures: [] });
  });
});

describe('publisher clears the outbox marker', () => {
  const NOW = new Date('2026-11-13T12:00:00.000Z');
  const ok = (entries: PutEventsRequestEntry[]): PutEventsResultEntry[] => entries.map(() => ({ EventId: 'e' }));

  it('clears the marker of each accepted entry, after PutEvents', async () => {
    const order: string[] = [];
    const cleared: unknown[] = [];
    const send = (entries: PutEventsRequestEntry[]) => {
      order.push('send');
      return Promise.resolve(ok(entries));
    };
    const clear = (key: unknown, at: string) => {
      order.push('clear');
      cleared.push([key, at]);
      return Promise.resolve();
    };
    const res = await createPublisher({ send, busName: BUS, log: () => undefined, clear, now: () => NOW })({
      Records: [outbox('1', 'a', 1), outbox('2', 'b', 1)],
    });
    expect(res).toEqual({ batchItemFailures: [] });
    expect(order).toEqual(['send', 'clear', 'clear']);
    expect(cleared).toEqual([
      [{ PK: 'TRIP#a', SK: 'EVENT#000001' }, NOW.toISOString()],
      [{ PK: 'TRIP#b', SK: 'EVENT#000001' }, NOW.toISOString()],
    ]);
  });

  it('does not clear a rejected entry or anything after it', async () => {
    const cleared: unknown[] = [];
    const send = (entries: PutEventsRequestEntry[]) =>
      Promise.resolve(entries.map((_, i) => (i === 1 ? { ErrorCode: 'InternalFailure' } : { EventId: 'e' })));
    const clear = (key: unknown) => {
      cleared.push(key);
      return Promise.resolve();
    };
    const res = await createPublisher({ send, busName: BUS, log: () => undefined, clear, now: () => NOW })({
      Records: [outbox('11', 'a', 1), outbox('12', 'b', 1), outbox('13', 'c', 1)],
    });
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '12' }] });
    expect(cleared).toEqual([{ PK: 'TRIP#a', SK: 'EVENT#000001' }]);
  });

  it('a failed clear is logged and the batch still succeeds', async () => {
    const logs: Record<string, unknown>[] = [];
    const send = (entries: PutEventsRequestEntry[]) => Promise.resolve(ok(entries));
    const clear = () => Promise.reject(new Error('throttled'));
    const res = await createPublisher({ send, busName: BUS, log: (l) => logs.push(l), clear, now: () => NOW })({
      Records: [outbox('1', 'a', 1, { correlationId: 'c-9' })],
    });
    expect(res).toEqual({ batchItemFailures: [] });
    expect(logs.filter((l) => l.msg === 'outbox marker not cleared')).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'outbox marker not cleared', correlationId: 'c-9' }),
    ]);
  });
});
