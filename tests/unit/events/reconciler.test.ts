import type { PutEventsRequestEntry, PutEventsResultEntry } from '@aws-sdk/client-eventbridge';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OutboxKey } from '../../../src/events/outbox-entry.ts';
import { createReconciler } from '../../../src/events/reconciler.ts';
import { OUTBOX_SHARDS, outboxKey, outboxPendingGsi2, outboxPendingPk, outboxShard } from '../../../src/infra/dynamo/keys.ts';

const BUS = 'ridecore';
const NOW = new Date('2026-11-13T12:20:30.000Z'); // minute 20 -> rotation starts at shard 0
const ago = (seconds: number, from = NOW) => new Date(from.getTime() - seconds * 1000).toISOString();

function tripInShard(shard: number): string {
  for (;;) {
    const id = randomUUID();
    if (outboxShard(id) === shard) return id;
  }
}

type Item = Record<string, unknown> & { GSI2PK?: string; GSI2SK?: string };

/** In-memory pending index with the same rules as the DynamoDB store. */
function memoryStore(failShard?: number) {
  const items = new Map<string, Item>();
  const calls: { shard: number; before: string; limit: number }[] = [];
  const cleared: OutboxKey[] = [];
  const deferred: OutboxKey[] = [];
  const id = (k: OutboxKey) => `${k.PK}|${k.SK}`;
  return {
    calls,
    cleared,
    deferred,
    add(tripId: string, occurredAt: string, version = 1) {
      items.set(id(outboxKey(tripId, version)), {
        schemaVersion: 1,
        eventId: `${tripId}:${version}`,
        type: 'trip.requested',
        tripId,
        version,
        occurredAt,
        payload: {},
        ...outboxKey(tripId, version),
        ...outboxPendingGsi2(tripId, occurredAt, version),
        entity: 'EVENT',
      });
    },
    store: {
      pending(shard: number, before: string, limit: number) {
        calls.push({ shard, before, limit });
        if (shard === failShard) return Promise.reject(new Error('query failed'));
        const found = [...items.values()]
          .filter((i) => i.GSI2PK === outboxPendingPk(shard) && String(i.GSI2SK) < before)
          .sort((a, b) => String(a.GSI2SK).localeCompare(String(b.GSI2SK)))
          .slice(0, limit);
        return Promise.resolve(found.map((i) => ({ ...i })));
      },
      clear(key: OutboxKey) {
        cleared.push(key);
        const item = items.get(id(key));
        if (item) {
          delete item.GSI2PK;
          delete item.GSI2SK;
        }
        return Promise.resolve();
      },
      defer(key: OutboxKey, gsi2sk: string) {
        deferred.push(key);
        const item = items.get(id(key));
        if (item?.GSI2PK !== undefined) item.GSI2SK = gsi2sk;
        return Promise.resolve();
      },
    },
  };
}

function bus(result: (e: PutEventsRequestEntry) => PutEventsResultEntry = () => ({ EventId: 'e' })) {
  const calls: PutEventsRequestEntry[][] = [];
  return {
    calls,
    send: (entries: PutEventsRequestEntry[]) => {
      calls.push(entries);
      return Promise.resolve(entries.map(result));
    },
  };
}

const tripOf = (e: PutEventsRequestEntry) => (JSON.parse(String(e.Detail)) as { tripId: string }).tripId;

describe('reconciler', () => {
  it('queries every shard with the cut now-60s', async () => {
    const mem = memoryStore();
    await createReconciler({ store: mem.store, send: bus().send, busName: BUS, log: () => undefined, now: () => NOW })();
    expect(mem.calls).toHaveLength(OUTBOX_SHARDS);
    expect(new Set(mem.calls.map((c) => c.shard)).size).toBe(OUTBOX_SHARDS);
    expect(mem.calls.every((c) => c.before === ago(60))).toBe(true);
  });

  it('publishes in chunks of at most 10, never two of one trip in a call', async () => {
    const mem = memoryStore();
    const twice = tripInShard(1);
    mem.add(twice, ago(300), 1);
    mem.add(twice, ago(299), 2);
    for (let i = 0; i < 10; i++) mem.add(tripInShard(1), ago(200 + i));
    const b = bus();
    const summary = await createReconciler({ store: mem.store, send: b.send, busName: BUS, log: () => undefined, now: () => NOW })();
    expect(b.calls.every((c) => c.length <= 10)).toBe(true);
    expect(b.calls.every((c) => new Set(c.map(tripOf)).size === c.length)).toBe(true);
    expect(summary).toMatchObject({ found: 12, published: 12, failed: 0 });
  });

  it('clears only accepted entries; a rejected one is deferred and counted as failed', async () => {
    const mem = memoryStore();
    const [ok1, bad, ok2] = [tripInShard(2), tripInShard(2), tripInShard(2)];
    mem.add(ok1, ago(300));
    mem.add(bad, ago(250));
    mem.add(ok2, ago(200));
    const b = bus((e) => (tripOf(e) === bad ? { ErrorCode: 'InternalFailure' } : { EventId: 'e' }));
    const summary = await createReconciler({ store: mem.store, send: b.send, busName: BUS, log: () => undefined, now: () => NOW })();
    expect(mem.cleared).toEqual([outboxKey(ok1, 1), outboxKey(ok2, 1)]);
    expect(mem.deferred).toEqual([outboxKey(bad, 1)]);
    expect(summary).toMatchObject({ found: 3, published: 2, failed: 1 });
  });

  it('a missing result is a failure', async () => {
    const mem = memoryStore();
    const [a, b2] = [tripInShard(3), tripInShard(3)];
    mem.add(a, ago(300));
    mem.add(b2, ago(200));
    const send = () => Promise.resolve([] as PutEventsResultEntry[]);
    const summary = await createReconciler({ store: mem.store, send, busName: BUS, log: () => undefined, now: () => NOW })();
    expect(mem.cleared).toEqual([]);
    expect(mem.deferred).toEqual([outboxKey(a, 1), outboxKey(b2, 1)]);
    expect(summary).toMatchObject({ published: 0, failed: 2 });
  });

  it('a stuck entry does not block newer ones across runs', async () => {
    const mem = memoryStore();
    const stuck = Array.from({ length: 50 }, () => tripInShard(0));
    stuck.forEach((t, i) => mem.add(t, ago(600 - i)));
    const fresh = tripInShard(0);
    mem.add(fresh, ago(120));
    const b = bus((e) => (stuck.includes(tripOf(e)) ? { ErrorCode: 'InternalFailure' } : { EventId: 'e' }));
    const run = (at: Date) => createReconciler({ store: mem.store, send: b.send, busName: BUS, log: () => undefined, now: () => at })();
    await run(NOW);
    await run(new Date(NOW.getTime() + 60_000));
    expect(mem.cleared).toContainEqual(outboxKey(fresh, 1));
  });

  it('splits the cap fairly', async () => {
    const mem = memoryStore();
    await createReconciler({ store: mem.store, send: bus().send, busName: BUS, log: () => undefined, now: () => NOW, maxPerRun: 500 })();
    expect(mem.calls.map((c) => c.limit)).toEqual(Array.from({ length: OUTBOX_SHARDS }, () => 50));
  });

  it('rotates the starting shard', async () => {
    const mem = memoryStore();
    const at = new Date('2026-11-13T12:23:00.000Z');
    await createReconciler({ store: mem.store, send: bus().send, busName: BUS, log: () => undefined, now: () => at })();
    expect(mem.calls.map((c) => c.shard)).toEqual([3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
  });

  it('a failing shard does not starve the others', async () => {
    const mem = memoryStore(0);
    const others = [1, 5, 9].map((s) => tripInShard(s));
    others.forEach((t) => mem.add(t, ago(300)));
    const logs: Record<string, unknown>[] = [];
    const summary = await createReconciler({ store: mem.store, send: bus().send, busName: BUS, log: (l) => logs.push(l), now: () => NOW })();
    expect(mem.cleared).toEqual(expect.arrayContaining(others.map((t) => outboxKey(t, 1))));
    expect(summary.published).toBe(3);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', msg: 'outbox shard failed', shard: 0 }));
  });

  it('a send that throws fails that shard only', async () => {
    const mem = memoryStore();
    const [inZero, inOne] = [tripInShard(0), tripInShard(1)];
    mem.add(inZero, ago(300));
    mem.add(inOne, ago(300));
    const send = (entries: PutEventsRequestEntry[]) =>
      entries.some((e) => tripOf(e) === inZero) ? Promise.reject(new Error('network down')) : Promise.resolve(entries.map(() => ({ EventId: 'e' })));
    const summary = await createReconciler({ store: mem.store, send, busName: BUS, log: () => undefined, now: () => NOW })();
    expect(mem.cleared).toEqual([outboxKey(inOne, 1)]);
    expect(summary).toMatchObject({ found: 2, published: 1, failed: 1 });
  });

  it('logs one summary', async () => {
    const mem = memoryStore();
    mem.add(tripInShard(6), ago(150));
    mem.add(tripInShard(7), ago(90));
    const logs: Record<string, unknown>[] = [];
    await createReconciler({ store: mem.store, send: bus().send, busName: BUS, log: (l) => logs.push(l), now: () => NOW })();
    expect(logs.filter((l) => l.msg === 'outbox reconciled')).toEqual([
      { level: 'info', msg: 'outbox reconciled', found: 2, published: 2, failed: 0, oldestAgeSeconds: 150 },
    ]);
    const empty: Record<string, unknown>[] = [];
    await createReconciler({ store: memoryStore().store, send: bus().send, busName: BUS, log: (l) => empty.push(l), now: () => NOW })();
    expect(empty).toContainEqual(expect.objectContaining({ msg: 'outbox reconciled', found: 0, oldestAgeSeconds: 0 }));
  });

  it('a failed clear does not count as failed publish', async () => {
    const mem = memoryStore();
    mem.add(tripInShard(8), ago(300));
    const logs: Record<string, unknown>[] = [];
    const store = { ...mem.store, clear: () => Promise.reject(new Error('throttled')) };
    const summary = await createReconciler({ store, send: bus().send, busName: BUS, log: (l) => logs.push(l), now: () => NOW })();
    expect(summary).toMatchObject({ published: 1, failed: 0 });
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'outbox marker not cleared' }));
  });
});
