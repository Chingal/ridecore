import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';

/**
 * The trip flow on the Go path (Plan 7): driver positions go to ridecore-location, dispatch finds the
 * driver through it, the trip events reach it through SQS, and the passenger gets the driver's
 * position on its map socket. Skipped unless RIDECORE_LOCATION_URL is set (`make up LOCATION=1`), so
 * the default e2e run is unchanged.
 */
const LOCATION_URL = process.env.RIDECORE_LOCATION_URL?.trim().replace(/\/+$/, '') ?? '';
const on = LOCATION_URL !== '';
const env = (name: string) => process.env[name] ?? '';
const API = env('RIDECORE_API_URL').replace(/\/$/, '');
const WS = env('RIDECORE_WS_URL');
const LOC_WS = env('RIDECORE_LOCATION_WS_URL').replace(/\/+$/, '');
const KEY = env('RIDECORE_LOCATION_KEY');
const SECRET = env('RIDECORE_JWT_SECRET');

type Person = Actor & { token: string };
type Message = Record<string, unknown> & { type: string };
type Socket = { ws: WebSocket; messages: Message[] };

async function person(role: Actor['role']): Promise<Person> {
  const id = `e2e-loc-${role}-${randomUUID()}`;
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

function open(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['ridecore.v1', token]);
    const socket: Socket = { ws, messages: [] };
    ws.onmessage = (m) => socket.messages.push(JSON.parse(String(m.data)) as Message);
    ws.onopen = () => resolve(socket);
    ws.onerror = () => reject(new Error(`socket refused: ${url}`));
  });
}

/** Waits for a message matching `match`, running `poke` every 1.1 s (the Go socket allows ~1/s). */
async function until(what: string, socket: Socket, match: (m: Message) => boolean, poke: () => unknown = () => undefined, timeoutMs = 60_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  let nextPoke = 0;
  for (;;) {
    const found = socket.messages.find(match);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last messages ${JSON.stringify(socket.messages.slice(-3))}`);
    if (Date.now() >= nextPoke) {
      await poke();
      nextPoke = Date.now() + 1100;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function nearbyIds(p: LatLng): Promise<string[]> {
  const res = await fetch(`${LOCATION_URL}/v1/nearby?lat=${p.lat}&lng=${p.lng}&limit=50`, { headers: { authorization: `Bearer ${KEY}` } });
  const body = (await res.json()) as { drivers: { driverId: string }[] };
  return body.drivers.map((d) => d.driverId);
}

// Florencia (Caquetá): no other e2e test, demo seed or load actor uses this area.
const ORIGIN: LatLng = { lat: 1.6144 + (Math.random() - 0.5) * 0.002, lng: -75.6062 + (Math.random() - 0.5) * 0.002 };
const DESTINATION: LatLng = { lat: ORIGIN.lat + 0.02, lng: ORIGIN.lng + 0.01 };

const leftovers: { passenger?: Person; driver?: Person; tripId?: string; sockets: Socket[] } = { sockets: [] };

describe.skipIf(!on)(`trip flow on the Go path (${LOCATION_URL})`, () => {
  const deps = on ? createDeps({ doc: createDocumentClient(createDynamoClient()), table: env('RIDECORE_TABLE'), jwtSecret: SECRET, log: () => undefined }) : undefined;

  afterAll(async () => {
    for (const s of leftovers.sockets) s.ws.close();
    const { passenger, driver, tripId } = leftovers;
    if (deps === undefined) return;
    if (tripId !== undefined && passenger !== undefined) {
      const trip = await deps.trips.get(tripId);
      if (trip !== null && ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED'].includes(trip.state)) {
        await deps.dispatch.finishTrip(tripId, { type: 'CANCEL', reason: 'e2e cleanup' }, passenger, new Date());
      }
    }
    if (driver !== undefined) await deps.drivers.setAvailability(driver.id, 'OFFLINE');
  });

  it('position via location -> offer -> accept -> driver_position to the passenger -> complete -> driver free again', async () => {
    const passenger = await person('passenger');
    const drv = await person('driver');
    leftovers.passenger = passenger;
    leftovers.driver = drv;
    // No position in DynamoDB: on the Go path the driver is found through ridecore-location only.
    await deps!.drivers.upsert({ id: drv.id, name: 'Driver LOC', vehicle: { plate: 'TST002', model: 'Demo sedan', category: 'STANDARD' }, availability: 'OFFLINE' });
    expect((await call('PUT', '/drivers/me/availability', drv, { status: 'AVAILABLE' })).status).toBe(200);

    const position = await open(`${LOC_WS}/v1/drivers/ws`, drv.token);
    const offers = await open(WS, drv.token);
    const map = await open(`${LOC_WS}/v1/map/ws`, passenger.token);
    leftovers.sockets.push(position, offers, map);
    map.ws.send(JSON.stringify({ action: 'watch', ...ORIGIN }));
    const sendPosition = () => position.ws.send(JSON.stringify({ action: 'position', ...ORIGIN }));

    // The car shows on the Go map and in the nearby query.
    await until('the car on the Go map', map, (m) => m.type === 'cars' && JSON.stringify(m.cars).includes(drv.id), sendPosition);
    expect(await nearbyIds(ORIGIN)).toContain(drv.id);

    const created = await call('POST', '/trips', passenger, { origin: ORIGIN, destination: DESTINATION }, { 'idempotency-key': randomUUID() });
    expect(created.status).toBe(201);
    const trip = created.body as unknown as Trip;
    leftovers.tripId = trip.id;

    await until('the offer pushed to the driver', offers, (m) => m.type === 'offer' && (m.offer as { tripId: string }).tripId === trip.id, sendPosition);
    expect((await call('POST', `/trips/${trip.id}/accept`, drv)).status).toBe(200);

    // trip.accepted travels EventBridge -> SQS -> ridecore-location; then each position reaches the passenger.
    const pushed = await until('driver_position on the passenger map', map, (m) => m.type === 'driver_position' && m.tripId === trip.id, sendPosition);
    expect(pushed).toMatchObject({ schemaVersion: 1, lat: ORIGIN.lat, lng: ORIGIN.lng });
    expect(JSON.stringify(pushed)).not.toContain(drv.id);
    expect(await nearbyIds(ORIGIN)).not.toContain(drv.id); // busy drivers are hidden

    for (const action of ['arrive', 'start', 'complete']) expect((await call('POST', `/trips/${trip.id}/${action}`, drv)).status).toBe(200);

    // trip.completed frees the driver in ridecore-location too.
    const deadline = Date.now() + 60_000;
    while (!(await nearbyIds(ORIGIN)).includes(drv.id)) {
      if (Date.now() > deadline) throw new Error('the driver never became free in ridecore-location after trip.completed');
      sendPosition();
      await new Promise((r) => setTimeout(r, 1100));
    }
  });
});
