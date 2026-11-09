import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../src/domain/errors.ts';
import { signToken, verifyToken } from '../../../src/http/auth.ts';

const SECRET = 'unit-test-secret-unit-test-secret';
const key = (s: string) => new TextEncoder().encode(s);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function expect401(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect(err).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
}

describe('auth tokens', () => {
  it('round-trips an actor', async () => {
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);
    expect(await verifyToken(`Bearer ${token}`, SECRET)).toEqual({ id: 'p-1', role: 'passenger' });
  });

  it('matches the Bearer scheme case-insensitively', async () => {
    const token = await signToken({ id: 'd-1', role: 'driver' }, SECRET);
    expect(await verifyToken(`bearer ${token}`, SECRET)).toEqual({ id: 'd-1', role: 'driver' });
    expect(await verifyToken(`BEARER ${token}`, SECRET)).toEqual({ id: 'd-1', role: 'driver' });
  });

  it('rejects a missing header', async () => {
    await expect401(verifyToken(undefined, SECRET));
    await expect401(verifyToken('', SECRET));
  });

  it('rejects a header that is not Bearer <token>', async () => {
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);
    await expect401(verifyToken(token, SECRET));
    await expect401(verifyToken(`Basic ${token}`, SECRET));
    await expect401(verifyToken('Bearer ', SECRET));
    await expect401(verifyToken('Bearer not-a-jwt', SECRET));
  });

  it('rejects an expired token', async () => {
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET, -10);
    await expect401(verifyToken(`Bearer ${token}`, SECRET));
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signToken({ id: 'p-1', role: 'passenger' }, 'another-secret-another-secret-0000');
    await expect401(verifyToken(`Bearer ${token}`, SECRET));
  });

  it('rejects alg none', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'p-1', role: 'passenger', exp })}.`;
    await expect401(verifyToken(`Bearer ${token}`, SECRET));
  });

  it('rejects other algorithms even with the right secret', async () => {
    const token = await new SignJWT({ role: 'passenger' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject('p-1')
      .setExpirationTime('1h')
      .sign(key(SECRET));
    await expect401(verifyToken(`Bearer ${token}`, SECRET));
  });

  it('rejects a token with an unknown role or no subject', async () => {
    const badRole = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('p-1')
      .setExpirationTime('1h')
      .sign(key(SECRET));
    await expect401(verifyToken(`Bearer ${badRole}`, SECRET));
    const noSub = await new SignJWT({ role: 'driver' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(key(SECRET));
    await expect401(verifyToken(`Bearer ${noSub}`, SECRET));
  });
});
