import { describe, expect, it, vi } from 'vitest';
import { depsFromEnv, jwtSecretFromEnv, MIN_JWT_SECRET_LENGTH } from '../../../src/http/deps.ts';

const SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);

describe('JWT secret from env (fail closed)', () => {
  it('rejects a missing or empty secret', () => {
    expect(() => jwtSecretFromEnv({})).toThrow('RIDECORE_JWT_SECRET is not set');
    expect(() => jwtSecretFromEnv({ RIDECORE_JWT_SECRET: '' })).toThrow('RIDECORE_JWT_SECRET is not set');
  });

  it(`rejects a secret shorter than ${MIN_JWT_SECRET_LENGTH} characters`, () => {
    expect(() => jwtSecretFromEnv({ RIDECORE_JWT_SECRET: SECRET.slice(1) })).toThrow(`at least ${MIN_JWT_SECRET_LENGTH} characters`);
  });

  it('accepts a secret of the minimum length', () => {
    expect(jwtSecretFromEnv({ RIDECORE_JWT_SECRET: SECRET })).toBe(SECRET);
  });

  it('depsFromEnv refuses to build without a valid secret or table', () => {
    expect(() => depsFromEnv({ RIDECORE_TABLE: 't' })).toThrow('RIDECORE_JWT_SECRET is not set');
    expect(() => depsFromEnv({ RIDECORE_TABLE: 't', RIDECORE_JWT_SECRET: 'short' })).toThrow('at least');
    expect(() => depsFromEnv({ RIDECORE_JWT_SECRET: SECRET })).toThrow('RIDECORE_TABLE is not set');
    expect(depsFromEnv({ RIDECORE_TABLE: 't', RIDECORE_JWT_SECRET: SECRET }).jwtSecret).toBe(SECRET);
  });
});

describe('Lambda entry (src/http/lambda.ts)', () => {
  it('fails at module init (cold start) when the JWT secret is missing or short', async () => {
    for (const secret of [undefined, 'short']) {
      vi.resetModules();
      vi.stubEnv('RIDECORE_TABLE', 't');
      vi.stubEnv('RIDECORE_JWT_SECRET', secret);
      await expect(import('../../../src/http/lambda.ts')).rejects.toThrow('RIDECORE_JWT_SECRET');
      vi.unstubAllEnvs();
    }
  });

  it('initializes with a valid configuration', async () => {
    vi.resetModules();
    vi.stubEnv('RIDECORE_TABLE', 't');
    vi.stubEnv('RIDECORE_JWT_SECRET', SECRET);
    await expect(import('../../../src/http/lambda.ts')).resolves.toHaveProperty('handler');
    vi.unstubAllEnvs();
  });
});
