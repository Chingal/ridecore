import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { hashRequest, IdempotencyRepo } from '../../src/infra/dynamo/idempotency-repo.ts';
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
    const a = repo.run('p-1', 'k-conc', 'h', fn).then(
      (v) => v,
      (e: unknown) => e,
    );
    const b = repo.run('p-1', 'k-conc', 'h', fn).then(
      (v) => v,
      (e: unknown) => e,
    );
    // let both reach the claim, then let the winner finish
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.all([a, b]);
    expect(calls).toBe(1);
    const errors = results.filter((r): r is DomainError => r instanceof DomainError);
    const ok = results.filter((r) => !(r instanceof DomainError));
    expect(ok).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
  });

  it('answers 409 REQUEST_IN_PROGRESS for a claim that has no response yet', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = repo.run('p-1', 'k-busy', 'h', async () => {
      await gate;
      return { status: 200, body: {} };
    });
    await new Promise((r) => setTimeout(r, 200));
    const err = await repo.run('p-1', 'k-busy', 'h', async () => ({ status: 200, body: {} })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'REQUEST_IN_PROGRESS', status: 409 });
    release();
    await first;
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
