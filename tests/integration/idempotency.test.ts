import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.ts';
import { toEvent } from '../../src/domain/events.ts';
import type { Actor, Trip } from '../../src/domain/trip.ts';
import type { LogLine } from '../../src/log.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import {
  type Complete,
  hashRequest,
  IDEMPOTENCY_LEASE_SECONDS,
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyRepo,
} from '../../src/infra/dynamo/idempotency-repo.ts';
import { tag, tagExtra, transact, CONCURRENT_UPDATE } from '../../src/infra/dynamo/transact.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let repo: IdempotencyRepo;

beforeAll(async () => {
  table = await createTestTable(client, 'idempotency');
  repo = new IdempotencyRepo(doc, table, Date.now, log);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

/**
 * What a use case does: ONE transaction with its business item (a marker here) and the completion
 * item, then returns the response it stored.
 */
function writes<T>(marker: string, status: number, body: T) {
  return async (complete: Complete<T>) => {
    await transact(doc, [
      tag({ Put: { TableName: table, Item: { PK: marker, SK: 'MARK' } } }, CONCURRENT_UPDATE),
      tagExtra(complete(status, body), 0),
    ]);
    return { status, body };
  };
}

const mark = () => `MARK#${randomUUID()}`;

const passenger = (id: string): Actor => ({ id, role: 'passenger' });
const P = {
  'p-1': passenger('p-1'),
  'p-2': passenger('p-2'),
  'p-8': passenger('p-8'),
  'p-9': passenger('p-9'),
} satisfies Record<string, Actor>;
const passengerOf = (trip: Trip) => passenger(trip.passengerId);

/** Log lines the repositories under test wrote (they log through the injected logger, not the console). */
let logs: LogLine[] = [];
const log = (line: LogLine) => logs.push(line);
const takeMsgs = () => {
  const msgs = logs.map((l) => l.msg);
  logs = [];
  return msgs;
};

async function markerExists(marker: string): Promise<boolean> {
  const res = await doc.send(new GetCommand({ TableName: table, Key: { PK: marker, SK: 'MARK' }, ConsistentRead: true }));
  return res.Item !== undefined;
}

describe('IdempotencyRepo.run', () => {
  it('replays the stored response for the same key and hash, running fn once', async () => {
    let calls = 0;
    const fn = (complete: Complete<{ id: string }>) => writes(mark(), 201, { id: `t-${++calls}` })(complete);
    const first = await repo.run(P['p-1'], 'k-replay', 'h1', fn);
    const second = await repo.run(P['p-1'], 'k-replay', 'h1', fn);
    expect(first).toEqual({ status: 201, body: { id: 't-1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 't-1' }, replayed: true });
    expect(calls).toBe(1);
  });

  it('stores the item with a 24 h TTL', async () => {
    await repo.run(P['p-1'], 'k-ttl', 'h', writes(mark(), 200, {}));
    const res = await doc.send(
      new GetCommand({ TableName: table, Key: { PK: 'IDEM#passenger#p-1#k-ttl', SK: 'META' }, ConsistentRead: true }),
    );
    const expiresAt = res.Item?.expiresAt as number;
    const nowSec = Date.now() / 1000;
    expect(expiresAt).toBeGreaterThan(nowSec + 86400 - 60);
    expect(expiresAt).toBeLessThan(nowSec + 86400 + 60);
  });

  it('rejects the same key with a different hash with 422', async () => {
    await repo.run(P['p-1'], 'k-reuse', 'h1', writes(mark(), 200, {}));
    const err = await repo.run(P['p-1'], 'k-reuse', 'h2', writes(mark(), 200, {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
  });

  it('scopes keys per actor', async () => {
    let calls = 0;
    const fn = (complete: Complete<{ n: number }>) => writes(mark(), 200, { n: ++calls })(complete);
    await repo.run(P['p-1'], 'k-shared', 'h', fn);
    const other = await repo.run(P['p-2'], 'k-shared', 'h', fn);
    expect(other.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('scopes keys per role: a driver with the same subject never replays a passenger response', async () => {
    let calls = 0;
    const fn = (complete: Complete<{ n: number }>) => writes(mark(), 200, { n: ++calls })(complete);
    await repo.run({ id: 'same-sub', role: 'passenger' }, 'k-role', 'h', fn);
    const asDriver = await repo.run({ id: 'same-sub', role: 'driver' }, 'k-role', 'h', fn);
    expect(asDriver).toEqual({ status: 200, body: { n: 2 }, replayed: false });
  });

  it('treats an item past its expiresAt as absent, before TTL deletes it', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const clocked = new IdempotencyRepo(doc, table, () => t, log);
    await clocked.run(P['p-1'], 'k-expired', 'h1', writes(mark(), 200, { first: true }));
    t += (IDEMPOTENCY_TTL_SECONDS + 1) * 1000;
    // Same key, different request, after expiry: a fresh claim (not 422), and its own response.
    expect(await clocked.run(P['p-1'], 'k-expired', 'h2', writes(mark(), 200, { second: true }))).toEqual({
      status: 200,
      body: { second: true },
      replayed: false,
    });
    expect(await clocked.run(P['p-1'], 'k-expired', 'h2', writes(mark(), 500, {}))).toMatchObject({ replayed: true });
  });

  it('releases the claim when fn throws so a retry runs fn again', async () => {
    let calls = 0;
    await expect(
      repo.run(P['p-1'], 'k-fail', 'h', async () => {
        calls++;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await repo.run(P['p-1'], 'k-fail', 'h', (c) => writes(mark(), 200, { calls: ++calls })(c));
    expect(retry).toEqual({ status: 200, body: { calls: 2 }, replayed: false });
  });

  it('lets only one of two concurrent identical requests run fn', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fn = async (complete: Complete<{ ok: boolean }>) => {
      calls++;
      await gate;
      return writes(mark(), 201, { ok: true })(complete);
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => v,
        (e: unknown) => e,
      );
    const a = settle(repo.run(P['p-1'], 'k-conc', 'h', fn));
    const b = settle(repo.run(P['p-1'], 'k-conc', 'h', fn));
    try {
      // The winner is blocked on the gate, so the first request to settle is the loser.
      const loser = await Promise.race([a, b]);
      expect(loser).toBeInstanceOf(DomainError);
      expect(loser).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
    } finally {
      release();
    }
    const results = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(results.filter((r) => r instanceof DomainError)).toHaveLength(1);
    expect(results.filter((r) => !(r instanceof DomainError))).toEqual([{ status: 201, body: { ok: true }, replayed: false }]);
  });

  it('answers 409 REQUEST_IN_PROGRESS for a claim that has no response yet', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const running = new Promise<void>((r) => (started = r));
    const first = repo.run(P['p-1'], 'k-busy', 'h', async (complete) => {
      started();
      await gate;
      return writes(mark(), 200, {})(complete);
    });
    try {
      await running;
      const err = await repo.run(P['p-1'], 'k-busy', 'h', writes(mark(), 200, {})).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
    } finally {
      release();
    }
    await first;
  });
});

describe('claim lease and failed cleanup', () => {
  const failingDeletes = (): DynamoDBDocumentClient =>
    ({
      send: (cmd: unknown) => (cmd instanceof DeleteCommand ? Promise.reject(new Error('delete down')) : doc.send(cmd as never)),
    }) as unknown as DynamoDBDocumentClient;

  it('rethrows the original error, logs the cleanup failure, and lets a retry take over after the lease', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const flaky = new IdempotencyRepo(failingDeletes(), table, () => t, log);
    const healthy = new IdempotencyRepo(doc, table, () => t, log);
    logs = [];
    await expect(
      flaky.run(P['p-9'], 'k-lease', 'h', async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    // Through the injected logger, not the console.
    expect(logs).toEqual([
      {
        level: 'error',
        msg: 'idempotency_cleanup_failed',
        role: 'passenger',
        actorId: 'p-9',
        key: 'k-lease',
        error: 'delete down',
      },
    ]);

    const fn = writes(mark(), 200, { ran: true });
    // Inside the lease: still blocked.
    t += (IDEMPOTENCY_LEASE_SECONDS - 1) * 1000;
    await expect(healthy.run(P['p-9'], 'k-lease', 'h', fn)).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
    // A different request is still refused after expiry.
    t += 2000;
    await expect(healthy.run(P['p-9'], 'k-lease', 'other', fn)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // Lease expired: the same request takes over and runs.
    expect(await healthy.run(P['p-9'], 'k-lease', 'h', fn)).toEqual({ status: 200, body: { ran: true }, replayed: false });
    expect(await healthy.run(P['p-9'], 'k-lease', 'h', fn)).toMatchObject({ replayed: true });
  });

  /** A claims, outlives its lease, B takes over and completes; returns what A needs to finish late. */
  async function staleScenario(key: string) {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const a = new IdempotencyRepo(doc, table, () => t, log);
    let releaseA: () => void = () => {};
    let startedA: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const aRunning = new Promise<void>((r) => (startedA = r));
    const aMarker = mark();
    const finishA = (outcome: 'ok' | 'fail') =>
      a.run(P['p-8'], key, 'h', async (complete) => {
        startedA();
        await gateA;
        if (outcome === 'fail') throw new Error('A failed');
        return writes(aMarker, 200, { by: 'A' })(complete);
      });
    return {
      finishA,
      aMarker,
      releaseA: () => releaseA(),
      aRunning,
      async completeB() {
        t += (IDEMPOTENCY_LEASE_SECONDS + 1) * 1000;
        const b = new IdempotencyRepo(doc, table, () => t, log);
        return { b, first: await b.run(P['p-8'], key, 'h', writes(mark(), 200, { by: 'B' })) };
      },
    };
  }

  it('keeps the new owner response when a stale owner fails after the takeover', async () => {
    const s = await staleScenario('k-stale-fail');
    logs = [];
    try {
      const aRun = s.finishA('fail').catch((e: unknown) => e);
      await s.aRunning;
      const { b, first } = await s.completeB();
      expect(first).toMatchObject({ body: { by: 'B' }, replayed: false });
      s.releaseA();
      expect(await aRun).toMatchObject({ message: 'A failed' });
      expect(takeMsgs()).toEqual(['idempotency_claim_kept']);
      expect(await b.run(P['p-8'], 'k-stale-fail', 'h', writes(mark(), 500, {}))).toEqual({
        status: 200,
        body: { by: 'B' },
        replayed: true,
      });
    } finally {
      s.releaseA();
    }
  });

  it('a stale owner that finishes after the takeover aborts its whole business transaction (nothing written)', async () => {
    const s = await staleScenario('k-stale-ok');
    logs = [];
    try {
      const aRun = s.finishA('ok').catch((e: unknown) => e);
      await s.aRunning;
      const { b } = await s.completeB();
      s.releaseA();
      // The completion's owner condition fails, so A's business item is not written either.
      expect(await aRun).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
      expect(await markerExists(s.aMarker)).toBe(false);
      expect(takeMsgs()).toEqual(['idempotency_claim_kept']);
      expect(await b.run(P['p-8'], 'k-stale-ok', 'h', writes(mark(), 500, {}))).toEqual({
        status: 200,
        body: { by: 'B' },
        replayed: true,
      });
    } finally {
      s.releaseA();
    }
  });

  it('lets only one of two concurrent takeovers of an expired lease run fn', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const flaky = new IdempotencyRepo(failingDeletes(), table, () => t, log);
    await flaky.run(P['p-9'], 'k-take', 'h', async () => Promise.reject(new Error('x'))).catch(() => undefined);
    t += (IDEMPOTENCY_LEASE_SECONDS + 1) * 1000;
    const healthy = new IdempotencyRepo(doc, table, () => t, log);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fn = async (complete: Complete<object>) => {
      calls++;
      await gate;
      return writes(mark(), 200, {})(complete);
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => v,
        (e: unknown) => e,
      );
    const a = settle(healthy.run(P['p-9'], 'k-take', 'h', fn));
    const b = settle(healthy.run(P['p-9'], 'k-take', 'h', fn));
    try {
      expect(await Promise.race([a, b])).toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    } finally {
      release();
    }
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

describe('response stored in the business transaction', () => {
  const at = '2026-11-09T12:00:00.000Z';
  const newTrip = (): Trip => ({
    id: randomUUID(),
    passengerId: `p-${randomUUID()}`,
    serviceType: 'STANDARD',
    origin: { lat: 0, lng: 0 },
    destination: { lat: 0.1, lng: 0 },
    state: 'REQUESTED',
    fareEstimate: 1,
    timestamps: { REQUESTED: at },
    version: 1,
    createdAt: at,
  });

  /** Commits every TransactWriteItems for real, then reports a failure, as if the reply were lost. */
  const lostReplies = (): DynamoDBDocumentClient =>
    ({
      send: async (cmd: unknown) => {
        const out = await doc.send(cmd as never);
        if (cmd instanceof TransactWriteCommand) throw new Error('socket hang up after commit');
        return out;
      },
    }) as unknown as DynamoDBDocumentClient;

  it('a crash right after the business commit leaves the response stored: the retry replays it and creates nothing', async () => {
    const trips = new TripRepo(doc, table);
    const trip = newTrip();
    logs = [];
    await expect(
      repo.run(passengerOf(trip), 'k-crash', 'h', async (complete) => {
        await trips.create(trip, toEvent(null, trip), [complete(201, trip)]);
        throw new Error('process died after commit');
      }),
    ).rejects.toThrow('process died');
    // The cleanup refuses to delete a claim that holds a response.
    expect(takeMsgs()).toEqual(['idempotency_claim_kept']);
    let calls = 0;
    const retry = await repo.run(passengerOf(trip), 'k-crash', 'h', async (complete) => {
      calls++;
      const other = { ...newTrip(), passengerId: trip.passengerId };
      await trips.create(other, toEvent(null, other), [complete(201, other)]);
      return { status: 201, body: other };
    });
    expect(retry).toEqual({ status: 201, body: trip, replayed: true });
    expect(calls).toBe(0);
    expect(await trips.history(trip.passengerId)).toEqual([trip]);
  });

  it('a lost reply from DynamoDB after commit (injected) is replayed on retry, not re-run', async () => {
    const trips = new TripRepo(lostReplies(), table);
    const flaky = new IdempotencyRepo(lostReplies(), table, Date.now, log);
    const trip = newTrip();
    await expect(
      flaky.run(passengerOf(trip), 'k-lost', 'h', async (complete) => {
        await trips.create(trip, toEvent(null, trip), [complete(201, trip)]);
        return { status: 201, body: trip };
      }),
    ).rejects.toThrow('socket hang up');
    const retry = await repo.run(passengerOf(trip), 'k-lost', 'h', async () => {
      throw new Error('must not run');
    });
    expect(retry).toEqual({ status: 201, body: trip, replayed: true });
  });

  it('a business transaction that aborts stores no response and releases the claim', async () => {
    const trips = new TripRepo(doc, table);
    const first = newTrip();
    await trips.create(first, toEvent(null, first));
    const second = { ...newTrip(), passengerId: first.passengerId };
    await expect(
      repo.run(passengerOf(first), 'k-abort', 'h', async (complete) => {
        await trips.create(second, toEvent(null, second), [complete(201, second)]);
        return { status: 201, body: second };
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_TRIP_EXISTS' });
    const res = await doc.send(
      new GetCommand({ TableName: table, Key: { PK: `IDEM#passenger#${first.passengerId}#k-abort`, SK: 'META' }, ConsistentRead: true }),
    );
    expect(res.Item).toBeUndefined();
  });

  it('refuses an fn that does not write the completion item, and releases the claim', async () => {
    await expect(repo.run(P['p-1'], 'k-nocomplete', 'h', async () => ({ status: 200, body: {} }))).rejects.toThrow(
      'fn must write complete',
    );
    expect(await repo.run(P['p-1'], 'k-nocomplete', 'h', writes(mark(), 200, { ok: 1 }))).toMatchObject({ replayed: false });
  });
});

describe('hashRequest', () => {
  it('is stable and sensitive to method, path and body', () => {
    const base = hashRequest('POST', '/trips', { a: 1, b: 2 });
    expect(hashRequest('POST', '/trips', { b: 2, a: 1 })).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRequest('PUT', '/trips', { a: 1, b: 2 })).not.toBe(base);
    expect(hashRequest('POST', '/trip', { a: 1, b: 2 })).not.toBe(base);
    expect(hashRequest('POST', '/trips', { a: 1, b: 3 })).not.toBe(base);
  });
});
