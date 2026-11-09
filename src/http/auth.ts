import { jwtVerify, SignJWT } from 'jose';
import { DomainError } from '../domain/errors.ts';
import type { Actor } from '../domain/trip.ts';

const ALG = 'HS256';
const BEARER = /^Bearer ([^\s]+)$/;

const unauthenticated = (message: string) => new DomainError('UNAUTHENTICATED', 401, message);
const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** Signs an HS256 token with claims `sub` (actor id) and `role`, valid for `ttlSeconds`. */
export async function signToken(actor: Actor, secret: string, ttlSeconds = 86400): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: actor.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(actor.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keyOf(secret));
}

/**
 * Verifies an `Authorization: Bearer <token>` header. Only HS256 is accepted (`alg: none` and every
 * other algorithm are rejected). Any failure is 401 UNAUTHENTICATED.
 */
export async function verifyToken(header: string | undefined, secret: string): Promise<Actor> {
  const token = header === undefined ? undefined : BEARER.exec(header)?.[1];
  if (token === undefined) throw unauthenticated('Missing or malformed bearer token');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keyOf(secret), { algorithms: [ALG] }));
  } catch {
    throw unauthenticated('Invalid or expired token');
  }
  const { sub, role } = payload;
  if (typeof sub !== 'string' || sub === '' || (role !== 'passenger' && role !== 'driver')) {
    throw unauthenticated('Invalid token claims');
  }
  return { id: sub, role };
}
