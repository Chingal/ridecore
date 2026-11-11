import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import type { ServerMessage } from '../../src/realtime/messages.ts';

/**
 * Real time over the Floci WebSocket API (ADR 0005): a passenger watching the map sees a car, the
 * driver gets the offer pushed, both get the trip updates, the car leaves the map once it is on a
 * trip, and the driver's position then reaches only that passenger. HTTP calls go to
 * `RIDECORE_API_URL` (Floci Lambda or the local adapter); sockets always go to `RIDECORE_WS_URL`.
 */
function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set: ${hint}`);
  return value;
}
const API = required('RIDECORE_API_URL', "run 'make up' (writes .env.deploy) or export it").replace(/\/$/, '');
const WS = required('RIDECORE_WS_URL', "run 'make up' (writes .env.deploy) or export it");
const TABLE = required('RIDECORE_TABLE', 'expected from .env.deploy or .env.example');
const SECRET = required('RIDECORE_JWT_SECRET', 'expected from .env.example');
const deps = createDeps({ doc: createDocumentClient(createDynamoClient()), table: TABLE, jwtSecret: SECRET, log: () => undefined });

type Person = Actor & { token: string };
type Socket = { ws: WebSocket; messages: ServerMessage[] };

async function person(role: Actor['role']): Promise<Person> {
  const id = `e2e-rt-${role}-${randomUUID()}`;
  return { id, role, token: await signToken({ id, role }, SECRET) };
}

async function call(method: string, path: string, who: Person, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${who.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Opens a socket with the ridecore subprotocol; rejects if the server refuses it. */
function open(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS, ['ridecore.v1', token]);
    const socket: Socket = { ws, messages: [] };
    ws.onmessage = (m) => socket.messages.push(JSON.parse(String(m.data)) as ServerMessage);
    ws.onopen = () => resolve(socket);
    ws.onerror = () => reject(new Error('socket refused'));
  });
}

/**
 * Waits until a message matching `match` arrives on `socket`, running `poke` every 3.5 s meanwhile
 * (past the 3 s position throttle), and fails naming `what` after `timeoutMs`.
 */
async function until<T extends ServerMessage>(
  what: string,
  socket: Socket,
  match: (m: ServerMessage) => m is T,
  poke: () => Promise<unknown> = async () => undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nextPoke = 0;
  for (;;) {
    const found = socket.messages.find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}; got ${JSON.stringify(socket.messages)}`);
    if (Date.now() >= nextPoke) {
      await poke();
      nextPoke = Date.now() + 3500;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const send = (s: Socket, message: unknown) => s.ws.send(JSON.stringify(message));

// Its own point near Popayán, jittered per run, away from the HTTP e2e's area.
const ORIGIN: LatLng = { lat: 2.4519 + (Math.random() - 0.5) * 0.002, lng: -76.5963 + (Math.random() - 0.5) * 0.002 };
const DESTINATION: LatLng = { lat: ORIGIN.lat + 0.02, lng: ORIGIN.lng + 0.01 };
const nudge = (p: LatLng, i: number): LatLng => ({ lat: p.lat + i * 0.00001, lng: p.lng });

const leftovers: { passenger?: Person; driver?: Person; tripId?: string; sockets: Socket[] } = { sockets: [] };

afterAll(async () => {
  for (const s of leftovers.sockets) s.ws.close();
  const { passenger, driver, tripId } = leftovers;
  if (tripId !== undefined && passenger !== undefined) {
    const trip = await deps.trips.get(tripId);
    if (trip !== null && ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED'].includes(trip.state)) {
      await deps.dispatch.finishTrip(tripId, { type: 'CANCEL', reason: 'e2e cleanup' }, passenger, new Date());
    }
  }
  if (driver !== undefined) await deps.drivers.setAvailability(driver.id, 'OFFLINE');
});

describe(`real time over WebSocket (${WS})`, () => {
  it('refuses a socket without a valid token', async () => {
    await expect(open('not-a-token')).rejects.toThrow('socket refused');
  });

  it('car on the map -> offer pushed -> trip updates to both -> car leaves -> position only to the passenger', async () => {
    const passenger = await person('passenger');
    const drv = await person('driver');
    leftovers.passenger = passenger;
    await deps.drivers.upsert({ id: drv.id, name: 'Driver RT', vehicle: { plate: 'TST001', model: 'Demo sedan', category: 'STANDARD' }, availability: 'OFFLINE' });
    leftovers.driver = drv;
    expect((await call('PUT', '/drivers/me/position', drv, ORIGIN)).status).toBe(200);
    expect((await call('PUT', '/drivers/me/availability', drv, { status: 'AVAILABLE' })).status).toBe(200);

    const p = await open(passenger.token);
    const d = await open(drv.token);
    leftovers.sockets.push(p, d);
    send(p, { action: 'watch', ...ORIGIN });

    let i = 0;
    const moveDriver = async () => send(d, { action: 'position', ...nudge(ORIGIN, ++i) });
    const car = await until('the car on the passenger map', p, (m): m is Extract<ServerMessage, { type: 'car' }> => m.type === 'car' && m.driverId === drv.id, moveDriver);
    expect(car).toMatchObject({ schemaVersion: 1, category: 'STANDARD' });
    expect(JSON.stringify(p.messages)).not.toContain('Driver RT');

    const created = await call('POST', '/trips', passenger, { origin: ORIGIN, destination: DESTINATION }, { 'idempotency-key': randomUUID() });
    expect(created.status).toBe(201);
    const trip = created.body as unknown as Trip;
    leftovers.tripId = trip.id;

    await until('the offer pushed to the driver', d, (m): m is Extract<ServerMessage, { type: 'offer' }> => m.type === 'offer' && m.offer.tripId === trip.id);
    const requested = await until('trip.requested for the passenger', p, (m): m is Extract<ServerMessage, { type: 'trip' }> => m.type === 'trip' && m.event.tripId === trip.id && m.event.type === 'trip.requested');
    expect(requested.event.version).toBe(1);

    expect((await call('POST', `/trips/${trip.id}/accept`, drv)).status).toBe(200);
    const accepted = (m: ServerMessage): m is Extract<ServerMessage, { type: 'trip' }> => m.type === 'trip' && m.event.tripId === trip.id && m.event.type === 'trip.accepted';
    expect((await until('trip.accepted for the passenger', p, accepted)).event.version).toBe(2);
    expect((await until('trip.accepted for the driver', d, accepted)).event.version).toBe(2);
    await until('car.left once the driver is on the trip', p, (m): m is Extract<ServerMessage, { type: 'car.left' }> => m.type === 'car.left' && m.driverId === drv.id);

    const seen = p.messages.length;
    const position = await until(
      "the driver's position for the passenger's trip",
      p,
      (m): m is Extract<ServerMessage, { type: 'driver_position' }> => m.type === 'driver_position' && m.tripId === trip.id,
      moveDriver,
    );
    expect(position.position.lat).toBeGreaterThan(ORIGIN.lat);
    expect(p.messages.slice(seen).some((m) => m.type === 'car' && m.driverId === drv.id)).toBe(false);
  }, 240_000);
});
