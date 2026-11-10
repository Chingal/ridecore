import { describe, expect, it } from 'vitest';
import { idempotencyKey } from '../../../src/infra/dynamo/keys.ts';

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
