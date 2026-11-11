import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import ngeohash from 'ngeohash';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor, LatLng } from '../../../src/domain/trip.ts';
import { cellOf } from '../../../src/infra/dynamo/driver-repo.ts';
import type { ServerMessage } from '../../../src/realtime/messages.ts';
import { createPositionsHandler, POSITION_THROTTLE_MS } from '../../../src/realtime/positions.ts';

const POPAYAN: LatLng = { lat: 2.4448, lng: -76.6147 };
const CELL = cellOf(POPAYAN);
const T0 = new Date('2026-11-11T12:00:00.000Z');

let now: Date;
let watchers: Record<string, string[]>;
let sockets: Record<string, string[]>;
let pushed: [string, ServerMessage][];
let failOn: string | undefined;
let lastAllowed: Map<string, number>;
let activeTrips: Record<string, string>;
let watchedCellsAsked: string[][];

const driverItem = (availability: string, extra: Record<string, unknown> = {}) => ({
  PK: 'DRIVER#d1',
  SK: 'META',
  entity: 'DRIVER',
  id: 'd1',
  name: 'Demo Driver',
  vehicle: { plate: 'DEMO01', model: 'Sedan', category: 'STANDARD' },
  availability,
  position: POPAYAN,
  geohash5: CELL,
  ...extra,
});

let seq = 0;
const record = (item: Record<string, unknown>, createdAt: Date = T0): DynamoDBRecord =>
  ({
    eventName: 'MODIFY',
    dynamodb: {
      SequenceNumber: String(++seq),
      ApproximateCreationDateTime: Math.floor(createdAt.getTime() / 1000),
      NewImage: marshall(item, { removeUndefinedValues: true }),
    },
  }) as unknown as DynamoDBRecord;
const stream = (...records: DynamoDBRecord[]): DynamoDBStreamEvent => ({ Records: records });

const handler = () =>
  createPositionsHandler({
    connections: {
      watchersOf: async (cells) => {
        watchedCellsAsked.push([...cells]);
        return [...new Set(cells.flatMap((c) => watchers[c] ?? []))];
      },
      byActor: async (a: Actor) => sockets[`${a.role}:${a.id}`] ?? [],
      remove: async () => undefined,
    },
    throttle: {
      once: async (scope, id, at, windowMs) => {
        const key = `${scope}/${id}`;
        const last = lastAllowed.get(key);
        if (last !== undefined && at.getTime() - last < windowMs) return false;
        lastAllowed.set(key, at.getTime());
        return true;
      },
    },
    trips: {
      activeTripId: async (kind, id) => (kind === 'DRIVER' ? (activeTrips[id] ?? null) : null),
      get: async (id) => (id === 't1' ? ({ id: 't1', passengerId: 'p1' } as never) : null),
    },
    pusher: {
      send: async (id, m) => {
        if (id === failOn) throw Object.assign(new Error('boom'), { name: 'InternalServerError' });
        pushed.push([id, m]);
        return 'sent';
      },
    },
    log: () => undefined,
    now: () => now,
  });

beforeEach(() => {
  now = T0;
  watchers = { [CELL]: ['w1'], [ngeohash.neighbors(CELL)[0] as string]: ['w2'] };
  sockets = { 'passenger:p1': ['pc'] };
  pushed = [];
  failOn = undefined;
  lastAllowed = new Map();
  activeTrips = {};
  watchedCellsAsked = [];
});

describe('positions handler', () => {
  it('broadcasts an AVAILABLE car to watchers of its cell and the 8 neighbours, without the driver name or plate', async () => {
    expect(await handler()(stream(record(driverItem('AVAILABLE'))))).toEqual({ batchItemFailures: [] });
    expect(watchedCellsAsked[0]?.sort()).toEqual([CELL, ...ngeohash.neighbors(CELL)].sort());
    expect(pushed.map(([id]) => id).sort()).toEqual(['w1', 'w2']);
    expect(pushed[0]?.[1]).toEqual({ type: 'car', schemaVersion: 1, driverId: 'd1', category: 'STANDARD', position: POPAYAN, at: T0.toISOString() });
    expect(JSON.stringify(pushed)).not.toMatch(/Demo Driver|DEMO01/);
  });

  it(`sends at most one update per driver every ${POSITION_THROTTLE_MS} ms`, async () => {
    expect(POSITION_THROTTLE_MS).toBe(3000);
    const h = handler();
    await h(stream(record(driverItem('AVAILABLE'))));
    now = new Date(T0.getTime() + 200);
    await h(stream(record(driverItem('AVAILABLE'))));
    expect(pushed.filter(([id]) => id === 'w1')).toHaveLength(1);
    now = new Date(T0.getTime() + 3000);
    await h(stream(record(driverItem('AVAILABLE'))));
    expect(pushed.filter(([id]) => id === 'w1')).toHaveLength(2);
  });

  it('ON_TRIP: watchers get car.left and never car; only the trip passenger gets driver_position', async () => {
    activeTrips = { d1: 't1' };
    await handler()(stream(record(driverItem('ON_TRIP'))));
    expect(pushed).toEqual(
      expect.arrayContaining([
        ['w1', { type: 'car.left', schemaVersion: 1, driverId: 'd1' }],
        ['w2', { type: 'car.left', schemaVersion: 1, driverId: 'd1' }],
        ['pc', { type: 'driver_position', schemaVersion: 1, tripId: 't1', position: POPAYAN, at: T0.toISOString() }],
      ]),
    );
    expect(pushed).toHaveLength(3);
    expect(pushed.some(([, m]) => m.type === 'car')).toBe(false);
  });

  it('OFFLINE: watchers of the stored cell get car.left, not throttled', async () => {
    const h = handler();
    await h(stream(record(driverItem('AVAILABLE'))));
    await h(stream(record(driverItem('OFFLINE'))));
    expect(pushed.filter(([id, m]) => id === 'w1' && m.type === 'car.left')).toHaveLength(1);
  });

  it('ignores items that are not drivers, and drivers with no position or cell', async () => {
    await handler()(
      stream(
        record({ PK: 'TRIP#t1', SK: 'META', entity: 'TRIP', id: 't1' }),
        record(driverItem('AVAILABLE', { position: undefined, geohash5: undefined })),
      ),
    );
    expect(pushed).toEqual([]);
  });

  it('ON_TRIP right after an AVAILABLE update still tells watchers the car left (car.left is never throttled)', async () => {
    const h = handler();
    await h(stream(record(driverItem('AVAILABLE'))));
    now = new Date(T0.getTime() + 500);
    await h(stream(record(driverItem('ON_TRIP'), now)));
    expect(pushed.filter(([id, m]) => id === 'w1' && m.type === 'car.left')).toHaveLength(1);
  });

  it(`skips records older than ${30} s (a late position must not reach a later trip's passenger)`, async () => {
    activeTrips = { d1: 't1' };
    now = new Date(T0.getTime() + 31_000);
    await handler()(stream(record(driverItem('ON_TRIP'), T0), record(driverItem('AVAILABLE'), T0)));
    expect(pushed).toEqual([]);
  });

  it('a failing push reports that record and stops, so the stream retries from it', async () => {
    failOn = 'w1';
    const first = record(driverItem('OFFLINE'));
    const res = await handler()(stream(first, record(driverItem('OFFLINE', { id: 'd2', PK: 'DRIVER#d2' }))));
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: first.dynamodb?.SequenceNumber }] });
  });
});
