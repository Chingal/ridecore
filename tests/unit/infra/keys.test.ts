import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { idempotencyKey, OUTBOX_SHARDS, outboxPendingGsi2, outboxPendingPk, outboxShard } from '../../../src/infra/dynamo/keys.ts';

describe('idempotencyKey', () => {
  it('is scoped by role and subject', () => {
    expect(idempotencyKey('passenger', 'u1', 'k').PK).not.toBe(idempotencyKey('driver', 'u1', 'k').PK);
    expect(idempotencyKey('passenger', 'u1', 'k')).toEqual({ PK: 'IDEM#passenger#u1#k', SK: 'META' });
  });

  it('encodes subject and key so the # separator cannot be forged', () => {
    expect(idempotencyKey('passenger', 'a', 'b#c').PK).not.toBe(idempotencyKey('passenger', 'a#b', 'c').PK);
    expect(idempotencyKey('passenger', 'a#b', 'c%d').PK).toBe('IDEM#passenger#a%23b#c%25d');
  });
});

describe('outbox pending keys', () => {
  it('outboxShard is stable and in range', () => {
    expect(outboxShard('t-1')).toBe(outboxShard('t-1'));
    const shards = Array.from({ length: 1000 }, () => outboxShard(randomUUID()));
    expect(shards.every((s) => Number.isInteger(s) && s >= 0 && s < OUTBOX_SHARDS)).toBe(true);
    expect(new Set(shards).size).toBeGreaterThanOrEqual(8);
  });

  it('outboxPendingGsi2 keys', () => {
    expect(outboxPendingGsi2('t-1', '2026-11-13T10:00:00.000Z', 3)).toEqual({
      GSI2PK: `OUTBOX#${outboxShard('t-1')}`,
      GSI2SK: '2026-11-13T10:00:00.000Z#t-1#000003',
    });
    expect(outboxPendingPk(4)).toBe('OUTBOX#4');
    expect(OUTBOX_SHARDS).toBe(10);
  });
});
