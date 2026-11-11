import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../../src/domain/errors.ts';
import type { Actor, LatLng } from '../../../src/domain/trip.ts';
import { signToken } from '../../../src/http/auth.ts';
import type { Connection } from '../../../src/infra/dynamo/connection-repo.ts';
import { cellOf } from '../../../src/infra/dynamo/driver-repo.ts';
import type { LogLine } from '../../../src/log.ts';
import type { ServerMessage } from '../../../src/realtime/messages.ts';
import { createWsHandler, SUBPROTOCOL, type WsEvent } from '../../../src/realtime/ws.ts';

const SECRET = 'unit-test-secret-unit-test-secret';
const NOW = new Date('2026-11-11T12:00:00.000Z');
const PASSENGER: Actor = { id: 'p-1', role: 'passenger' };
const DRIVER: Actor = { id: 'd-1', role: 'driver' };
const POPAYAN: LatLng = { lat: 2.4448, lng: -76.6147 };

let stored: Map<string, Connection>;
let watched: [string, string][];
let positions: [Actor, LatLng][];
let pushed: [string, ServerMessage][];
let logs: LogLine[];
let positionError: Error | undefined;

const handler = () =>
  createWsHandler({
    connections: {
      put: async (c) => void stored.set(c.connectionId, c),
      get: async (id) => stored.get(id) ?? null,
      remove: async (id) => void stored.delete(id),
      watch: async (id, cell) => void watched.push([id, cell]),
    },
    cars: {
      availableNear: async () => [
        { id: 'd7', name: 'Secret Name', vehicle: { plate: 'PLATE7', model: 'M', category: 'STANDARD' }, availability: 'AVAILABLE', position: POPAYAN, geohash5: cellOf(POPAYAN) },
      ],
    },
    drivers: {
      setPosition: async (actor, p) => {
        if (positionError) throw positionError;
        positions.push([actor, p]);
        return { id: actor.id, name: 'D', vehicle: { plate: 'X', model: 'Y', category: 'STANDARD' }, availability: 'AVAILABLE', position: p };
      },
    },
    pusher: { send: async (id, m) => (pushed.push([id, m]), 'sent') },
    secret: SECRET,
    log: (line) => void logs.push(line),
    now: () => NOW,
  });

const event = (routeKey: string, connectionId: string | undefined, extra: Partial<WsEvent> = {}): WsEvent =>
  ({ requestContext: { routeKey, connectionId, eventType: 'MESSAGE' }, isBase64Encoded: false, ...extra }) as unknown as WsEvent;

const connect = (connectionId: string, protocol?: string) =>
  handler()(event('$connect', connectionId, protocol === undefined ? {} : { headers: { 'Sec-WebSocket-Protocol': protocol } }));

const message = (connectionId: string, body: unknown) =>
  handler()(event('$default', connectionId, { body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  stored = new Map();
  watched = [];
  positions = [];
  pushed = [];
  logs = [];
  positionError = undefined;
});

describe('$connect', () => {
  it('stores the actor of a valid token and answers with the ridecore subprotocol', async () => {
    const token = await signToken(PASSENGER, SECRET);
    const res = await connect('c1', `${SUBPROTOCOL}, ${token}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'Sec-WebSocket-Protocol': SUBPROTOCOL });
    expect(stored.get('c1')).toEqual({ connectionId: 'c1', actor: PASSENGER, connectedAt: NOW.toISOString() });
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it('rejects a missing, malformed, expired or alg-none token with 401 and stores nothing', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ role: 'driver' }).setProtectedHeader({ alg: 'HS256' }).setSubject('d-1').setExpirationTime(now - 10).sign(new TextEncoder().encode(SECRET));
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none' })}.${b64({ sub: 'p-1', role: 'passenger', exp: now + 600 })}.`;
    for (const protocol of [undefined, SUBPROTOCOL, `other, ${expired}`, `${SUBPROTOCOL}, ${expired}`, `${SUBPROTOCOL}, ${none}`]) {
      expect((await connect('c2', protocol)).statusCode).toBe(401);
    }
    expect(stored.size).toBe(0);
    expect(JSON.stringify(logs)).not.toContain(expired);
  });
});

describe('$disconnect', () => {
  it('removes the connection', async () => {
    stored.set('c1', { connectionId: 'c1', actor: PASSENGER, connectedAt: NOW.toISOString() });
    expect((await handler()(event('$disconnect', 'c1'))).statusCode).toBe(200);
    expect(stored.has('c1')).toBe(false);
  });
});

describe('$default', () => {
  beforeEach(() => {
    stored.set('pc', { connectionId: 'pc', actor: PASSENGER, connectedAt: NOW.toISOString() });
    stored.set('dc', { connectionId: 'dc', actor: DRIVER, connectedAt: NOW.toISOString() });
  });

  it('a passenger watches the cell of a point and gets the cars already parked around it', async () => {
    expect((await message('pc', { action: 'watch', ...POPAYAN })).statusCode).toBe(200);
    expect(watched).toEqual([['pc', cellOf(POPAYAN)]]);
    expect(pushed).toEqual([['pc', { type: 'car', schemaVersion: 1, driverId: 'd7', category: 'STANDARD', position: POPAYAN, at: NOW.toISOString() }]]);
    expect(JSON.stringify(pushed)).not.toMatch(/Secret Name|PLATE7/);
  });

  it('a driver may not watch; a passenger may not send positions', async () => {
    await message('dc', { action: 'watch', ...POPAYAN });
    await message('pc', { action: 'position', ...POPAYAN });
    expect(watched).toEqual([]);
    expect(positions).toEqual([]);
    expect(pushed.map(([id, m]) => [id, m.type, 'code' in m ? m.code : null])).toEqual([
      ['dc', 'error', 'FORBIDDEN'],
      ['pc', 'error', 'FORBIDDEN'],
    ]);
  });

  it('a driver position goes through the driver service; its domain errors come back as error pushes', async () => {
    await message('dc', { action: 'position', ...POPAYAN });
    expect(positions).toEqual([[DRIVER, POPAYAN]]);

    positionError = new DomainError('DRIVER_NOT_FOUND', 404, 'Driver not found');
    await message('dc', { action: 'position', ...POPAYAN });
    expect(pushed).toEqual([['dc', { type: 'error', schemaVersion: 1, code: 'DRIVER_NOT_FOUND', message: 'Driver not found' }]]);
  });

  it('answers invalid messages with INVALID_MESSAGE and ping with pong', async () => {
    await message('dc', { action: 'position', lat: 91, lng: 0 });
    await message('dc', 'not json');
    await message('dc', { action: 'fly' });
    await message('pc', { action: 'ping' });
    expect(pushed.map(([id, m]) => [id, m.type, 'code' in m ? m.code : null])).toEqual([
      ['dc', 'error', 'INVALID_MESSAGE'],
      ['dc', 'error', 'INVALID_MESSAGE'],
      ['dc', 'error', 'INVALID_MESSAGE'],
      ['pc', 'pong', null],
    ]);
    expect(positions).toEqual([]);
  });

  it('does nothing for an unknown connection or a request without a connection id', async () => {
    expect((await message('ghost', { action: 'ping' })).statusCode).toBe(200);
    expect((await handler()(event('$default', undefined, { body: '{"action":"ping"}' }))).statusCode).toBe(200);
    expect(pushed).toEqual([]);
  });
});
