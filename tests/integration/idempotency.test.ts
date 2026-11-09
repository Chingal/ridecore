import { DeleteCommand, type DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../src/domain/errors.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { hashRequest, IDEMPOTENCY_LEASE_SECONDS, IdempotencyRepo } from '../../src/infra/dynamo/idempotency-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let repo: IdempotencyRepo;

beforeAll(async () => {
  table = await createTestTable(client, 'idempotency');
  repo = new IdempotencyRepo(doc, table);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

describe('IdempotencyRepo.run', () => {
  it('replays the stored response for the same key and hash, running fn once', async () => {
    let calls = 0;
    const fn = async () => ({ status: 201, body: { id: `t-${++calls}` } });
    const first = await repo.run('p-1', 'k-replay', 'h1', fn);
    const second = await repo.run('p-1', 'k-replay', 'h1', fn);
    expect(first).toEqual({ status: 201, body: { id: 't-1' }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 't-1' }, replayed: true });
    expect(calls).toBe(1);
  });

  it('stores the item with a 24 h TTL', async () => {
    await repo.run('p-1', 'k-ttl', 'h', async () => ({ status: 200, body: {} }));
    const res = await doc.send(
      new GetCommand({ TableName: table, Key: { PK: 'IDEM#p-1#k-ttl', SK: 'META' }, ConsistentRead: true }),
    );
    const expiresAt = res.Item?.expiresAt as number;
    const nowSec = Date.now() / 1000;
    expect(expiresAt).toBeGreaterThan(nowSec + 86400 - 60);
    expect(expiresAt).toBeLessThan(nowSec + 86400 + 60);
  });

  it('rejects the same key with a different hash with 422', async () => {
    await repo.run('p-1', 'k-reuse', 'h1', async () => ({ status: 200, body: {} }));
    const err = await repo.run('p-1', 'k-reuse', 'h2', async () => ({ status: 200, body: {} })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 422 });
  });

  it('scopes keys per actor', async () => {
    let calls = 0;
    const fn = async () => ({ status: 200, body: { n: ++calls } });
    await repo.run('p-1', 'k-shared', 'h', fn);
    const other = await repo.run('p-2', 'k-shared', 'h', fn);
    expect(other.replayed).toBe(false);
    expect(calls).toBe(2);
  });

  it('releases the claim when fn throws so a retry runs fn again', async () => {
    let calls = 0;
    await expect(
      repo.run('p-1', 'k-fail', 'h', async () => {
        calls++;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await repo.run('p-1', 'k-fail', 'h', async () => ({ status: 200, body: { calls: ++calls } }));
    expect(retry).toEqual({ status: 200, body: { calls: 2 }, replayed: false });
  });

  it('lets only one of two concurrent identical requests run fn', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fn = async () => {
      calls++;
      await gate;
      return { status: 201, body: { ok: true } };
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => v,
        (e: unknown) => e,
      );
    const a = settle(repo.run('p-1', 'k-conc', 'h', fn));
    const b = settle(repo.run('p-1', 'k-conc', 'h', fn));
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
    const first = repo.run('p-1', 'k-busy', 'h', async () => {
      started();
      await gate;
      return { status: 200, body: {} };
    });
    try {
      await running;
      const err = await repo.run('p-1', 'k-busy', 'h', async () => ({ status: 200, body: {} })).catch((e: unknown) => e);
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
    const flaky = new IdempotencyRepo(failingDeletes(), table, () => t);
    const healthy = new IdempotencyRepo(doc, table, () => t);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        flaky.run('p-9', 'k-lease', 'h', async () => {
          throw new Error('original');
        }),
      ).rejects.toThrow('original');
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        level: 'error',
        msg: 'idempotency_cleanup_failed',
        actorId: 'p-9',
        key: 'k-lease',
      });
    } finally {
      log.mockRestore();
    }

    const fn = async () => ({ status: 200, body: { ran: true } });
    // Inside the lease: still blocked.
    t += (IDEMPOTENCY_LEASE_SECONDS - 1) * 1000;
    await expect(healthy.run('p-9', 'k-lease', 'h', fn)).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
    // A different request is still refused after expiry.
    t += 2000;
    await expect(healthy.run('p-9', 'k-lease', 'other', fn)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    // Lease expired: the same request takes over and runs.
    expect(await healthy.run('p-9', 'k-lease', 'h', fn)).toEqual({ status: 200, body: { ran: true }, replayed: false });
    expect(await healthy.run('p-9', 'k-lease', 'h', fn)).toMatchObject({ replayed: true });
  });

  /** A claims, outlives its lease, B takes over and completes; returns what A needs to finish late. */
  async function staleScenario(key: string) {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const a = new IdempotencyRepo(doc, table, () => t);
    let releaseA: () => void = () => {};
    let startedA: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    const aRunning = new Promise<void>((r) => (startedA = r));
    const finishA = (outcome: 'ok' | 'fail') =>
      a.run('p-8', key, 'h', async () => {
        startedA();
        await gateA;
        if (outcome === 'fail') throw new Error('A failed');
        return { status: 200, body: { by: 'A' } };
      });
    return {
      finishA,
      releaseA: () => releaseA(),
      aRunning,
      async completeB() {
        t += (IDEMPOTENCY_LEASE_SECONDS + 1) * 1000;
        const b = new IdempotencyRepo(doc, table, () => t);
        return { b, first: await b.run('p-8', key, 'h', async () => ({ status: 200, body: { by: 'B' } })) };
      },
    };
  }

  it('keeps the new owner response when a stale owner fails after the takeover', async () => {
    const s = await staleScenario('k-stale-fail');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const aRun = s.finishA('fail').catch((e: unknown) => e);
      await s.aRunning;
      const { b, first } = await s.completeB();
      expect(first).toMatchObject({ body: { by: 'B' }, replayed: false });
      s.releaseA();
      expect(await aRun).toMatchObject({ message: 'A failed' });
      expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).msg)).toEqual(['idempotency_stale_owner']);
      expect(await b.run('p-8', 'k-stale-fail', 'h', async () => ({ status: 500, body: {} }))).toEqual({
        status: 200,
        body: { by: 'B' },
        replayed: true,
      });
    } finally {
      s.releaseA();
      log.mockRestore();
    }
  });

  it('keeps the new owner response when a stale owner succeeds after the takeover', async () => {
    const s = await staleScenario('k-stale-ok');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const aRun = s.finishA('ok');
      await s.aRunning;
      const { b } = await s.completeB();
      s.releaseA();
      expect(await aRun).toEqual({ status: 200, body: { by: 'A' }, replayed: false });
      expect(log.mock.calls.map((c) => JSON.parse(String(c[0])).msg)).toEqual(['idempotency_stale_owner']);
      expect(await b.run('p-8', 'k-stale-ok', 'h', async () => ({ status: 500, body: {} }))).toEqual({
        status: 200,
        body: { by: 'B' },
        replayed: true,
      });
    } finally {
      s.releaseA();
      log.mockRestore();
    }
  });

  it('lets only one of two concurrent takeovers of an expired lease run fn', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const flaky = new IdempotencyRepo(failingDeletes(), table, () => t);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await flaky.run('p-9', 'k-take', 'h', async () => Promise.reject(new Error('x'))).catch(() => undefined);
    log.mockRestore();
    t += (IDEMPOTENCY_LEASE_SECONDS + 1) * 1000;
    const healthy = new IdempotencyRepo(doc, table, () => t);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fn = async () => {
      calls++;
      await gate;
      return { status: 200, body: {} };
    };
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => v,
        (e: unknown) => e,
      );
    const a = settle(healthy.run('p-9', 'k-take', 'h', fn));
    const b = settle(healthy.run('p-9', 'k-take', 'h', fn));
    try {
      expect(await Promise.race([a, b])).toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    } finally {
      release();
    }
    await Promise.all([a, b]);
    expect(calls).toBe(1);
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
