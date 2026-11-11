import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps, type Deps, type LogLine } from '../../src/http/deps.ts';
import { createHandler } from '../../src/http/handler.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
const SECRET = 'integration-test-secret-not-real';
const BASE = new Date('2026-11-09T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let table: string;
let logs: LogLine[];

beforeAll(async () => {
  table = await createTestTable(client, 'http');
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

function deps(now: Date = BASE): Deps {
  logs = [];
  return createDeps({ doc, table, jwtSecret: SECRET, now: () => now, log: (line) => logs.push(line) });
}

type Api = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

type Call = { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };

function event(method: string, path: string, call: Call = {}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = { ...(call.headers ?? {}) };
  if (call.token !== undefined) headers.authorization = `Bearer ${call.token}`;
  const body = call.rawBody ?? (call.body === undefined ? undefined : JSON.stringify(call.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '000000000000',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: '09/Nov/2026:12:00:00 +0000',
      timeEpoch: BASE.getTime(),
    },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body }),
  };
}

type Res = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> };

async function send(api: Api, method: string, path: string, call: Call = {}): Promise<Res> {
  const res = await api(event(method, path, call));
  return {
    status: res.statusCode ?? 0,
    body: typeof res.body === 'string' && res.body !== '' ? (JSON.parse(res.body) as Record<string, unknown>) : {},
    headers: res.headers ?? {},
  };
}

const errorOf = (res: Res) => (res.body as { error: { code: string; message: string } }).error;
const tripOf = (res: Res) => res.body as unknown as Trip;

type Person = Actor & { token: string };

async function person(role: Actor['role']): Promise<Person> {
  const id = `${role === 'passenger' ? 'p' : 'd'}-${randomUUID()}`;
  return { id, role, token: await signToken({ id, role }, SECRET) };
}

/** A registered driver (registration is a seed concern, not an API route), OFFLINE with no position. */
async function driver(d: Deps): Promise<Person> {
  const p = await person('driver');
  await d.drivers.upsert({
    id: p.id,
    name: `Driver ${p.id.slice(2, 8)}`,
    vehicle: { plate: 'ABC123', model: 'Logan 2019', category: 'STANDARD' },
    availability: 'OFFLINE',
  });
  return p;
}

// Each test works in its own city so geohash-5 neighbourhoods never overlap between tests.
const POPAYAN: LatLng = { lat: 2.4448, lng: -76.6147 };
const CALI: LatLng = { lat: 3.4516, lng: -76.532 };
const PASTO: LatLng = { lat: 1.2136, lng: -77.2811 };
const NEIVA: LatLng = { lat: 2.9273, lng: -75.2819 };
const BOGOTA: LatLng = { lat: 4.711, lng: -74.0721 };
const MEDELLIN: LatLng = { lat: 6.2442, lng: -75.5812 };
const MANIZALES: LatLng = { lat: 5.0703, lng: -75.5138 };
const north = (p: LatLng, km: number): LatLng => ({ lat: p.lat + km / 111.2, lng: p.lng });

async function requestTrip(api: Api, passenger: Person, origin: LatLng, key = randomUUID()): Promise<Trip> {
  const res = await send(api, 'POST', '/trips', {
    token: passenger.token,
    headers: { 'idempotency-key': key },
    body: { origin, destination: north(origin, 3) },
  });
  expect(res.status).toBe(201);
  return tripOf(res);
}

/** Driver goes AVAILABLE at `at`, the trip is offered (dispatch called directly) and the driver accepts. */
async function acceptedTrip(api: Api, d: Deps, at: LatLng): Promise<{ passenger: Person; drv: Person; trip: Trip }> {
  const passenger = await person('passenger');
  const drv = await driver(d);
  expect((await send(api, 'PUT', '/drivers/me/position', { token: drv.token, body: at })).status).toBe(200);
  expect((await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'AVAILABLE' } })).status).toBe(200);
  const trip = await requestTrip(api, passenger, at);
  expect(await d.dispatch.offerTrip(trip.id, BASE)).toContain(drv.id);
  const accepted = await send(api, 'POST', `/trips/${trip.id}/accept`, { token: drv.token });
  expect(accepted.status).toBe(200);
  return { passenger, drv, trip: tripOf(accepted) };
}

async function completedTrip(api: Api, d: Deps, at: LatLng): Promise<{ passenger: Person; drv: Person; trip: Trip }> {
  const { passenger, drv, trip } = await acceptedTrip(api, d, at);
  for (const step of ['arrive', 'start', 'complete']) {
    expect((await send(api, 'POST', `/trips/${trip.id}/${step}`, { token: drv.token })).status).toBe(200);
  }
  return { passenger, drv, trip };
}

describe('happy path', () => {
  it('request -> offer -> accept -> arrive -> start -> complete -> rate', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const drv = await driver(d);

    const pos = await send(api, 'PUT', '/drivers/me/position', { token: drv.token, body: north(POPAYAN, 1) });
    expect(pos.status).toBe(200);
    expect(pos.body).toMatchObject({ id: drv.id, availability: 'OFFLINE', position: north(POPAYAN, 1) });
    const online = await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'AVAILABLE' } });
    expect(online.status).toBe(200);
    expect(online.body).toMatchObject({ id: drv.id, availability: 'AVAILABLE' });
    expect(online.body).not.toHaveProperty('geohash5');

    const created = await send(api, 'POST', '/trips', {
      token: passenger.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { origin: POPAYAN, destination: north(POPAYAN, 4) },
    });
    expect(created.status).toBe(201);
    const trip = tripOf(created);
    expect(trip).toMatchObject({ passengerId: passenger.id, state: 'REQUESTED', serviceType: 'STANDARD', version: 1 });
    expect(trip.fareEstimate).toBeGreaterThan(0);
    expect(trip.timestamps.REQUESTED).toBe(BASE.toISOString());

    expect(await d.dispatch.offerTrip(trip.id, BASE)).toEqual([drv.id]);
    const offers = await send(api, 'GET', '/drivers/me/offers', { token: drv.token });
    expect(offers.status).toBe(200);
    expect((offers.body.items as Trip[]).map((t) => t.id)).toEqual([trip.id]);
    // A driver with a pending offer may read the trip.
    expect((await send(api, 'GET', `/trips/${trip.id}`, { token: drv.token })).status).toBe(200);

    const expected = [
      ['accept', 'ACCEPTED'],
      ['arrive', 'DRIVER_ARRIVED'],
      ['start', 'IN_PROGRESS'],
      ['complete', 'COMPLETED'],
    ] as const;
    for (const [step, state] of expected) {
      const res = await send(api, 'POST', `/trips/${trip.id}/${step}`, { token: drv.token });
      expect(res.status, step).toBe(200);
      expect(tripOf(res)).toMatchObject({ state, driverId: drv.id });
    }
    expect((await d.drivers.get(drv.id))?.availability).toBe('AVAILABLE');
    // The assigned driver retrying accept sees a state conflict, not a 404 for a trip they can read.
    const reaccept = await send(api, 'POST', `/trips/${trip.id}/accept`, { token: drv.token });
    expect(reaccept.status).toBe(409);
    expect(errorOf(reaccept).code).toBe('INVALID_TRANSITION');

    const rated = await send(api, 'POST', `/trips/${trip.id}/rating`, {
      token: passenger.token,
      body: { score: 5, comment: 'Smooth ride' },
    });
    expect(rated.status).toBe(200);
    expect(tripOf(rated)).toMatchObject({ state: 'RATED', rating: { score: 5, comment: 'Smooth ride' }, finalFare: trip.fareEstimate });

    const mine = await send(api, 'GET', '/me/trips', { token: passenger.token });
    expect(mine.status).toBe(200);
    expect((mine.body.items as Trip[]).map((t) => [t.id, t.state])).toEqual([[trip.id, 'RATED']]);
    // The assigned driver can still read it.
    expect(tripOf(await send(api, 'GET', `/trips/${trip.id}`, { token: drv.token })).state).toBe('RATED');
  });
});

describe('authorization', () => {
  it("passenger B cannot read, cancel or rate A's trip -> 404 TRIP_NOT_FOUND", async () => {
    const d = deps();
    const api = createHandler(d);
    const { passenger, trip } = await completedTrip(api, d, CALI);
    const other = await person('passenger');
    const open = await requestTrip(api, passenger, north(CALI, 100));

    for (const [method, path, body] of [
      ['GET', `/trips/${open.id}`, undefined],
      ['POST', `/trips/${open.id}/cancel`, { reason: 'probe' }],
      ['POST', `/trips/${trip.id}/rating`, { score: 1 }],
    ] as const) {
      const res = await send(api, method, path, { token: other.token, body });
      expect(res.status, path).toBe(404);
      expect(errorOf(res).code, path).toBe('TRIP_NOT_FOUND');
    }
    // Nothing changed.
    expect((await d.trips.get(open.id))?.state).toBe('REQUESTED');
    expect((await d.trips.get(trip.id))?.state).toBe('COMPLETED');
  });

  it('a driver with no offer or assignment gets 404 TRIP_NOT_FOUND on every trip route', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const stranger = await driver(d);
    const trip = await requestTrip(api, passenger, PASTO);
    for (const [method, path] of [
      ['GET', `/trips/${trip.id}`],
      ['POST', `/trips/${trip.id}/accept`],
      ['POST', `/trips/${trip.id}/arrive`],
      ['POST', `/trips/${trip.id}/cancel`],
    ] as const) {
      const res = await send(api, method, path, { token: stranger.token });
      expect(res.status, path).toBe(404);
      expect(errorOf(res).code, path).toBe('TRIP_NOT_FOUND');
    }
    expect((await d.trips.get(trip.id))?.state).toBe('REQUESTED');
  });

  it('unknown and malformed trip ids -> 404 TRIP_NOT_FOUND', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    for (const id of [randomUUID(), 'not-a-uuid', 'x%23OFFER']) {
      const res = await send(api, 'GET', `/trips/${id}`, { token: passenger.token });
      expect(res.status, id).toBe(404);
      expect(errorOf(res).code).toBe('TRIP_NOT_FOUND');
    }
  });

  it('driver calling POST /trips -> 403 FORBIDDEN_ROLE (before the Idempotency-Key check)', async () => {
    const api = createHandler(deps());
    const drv = await person('driver');
    const res = await send(api, 'POST', '/trips', { token: drv.token, body: { origin: NEIVA, destination: north(NEIVA, 2) } });
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN_ROLE');
  });

  it('passenger calling a driver route -> 403 FORBIDDEN_ROLE', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    for (const [method, path] of [
      ['POST', `/trips/${randomUUID()}/accept`],
      ['PUT', '/drivers/me/availability'],
      ['GET', '/drivers/me/offers'],
    ] as const) {
      const res = await send(api, method, path, { token: passenger.token });
      expect(res.status, path).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('no token -> 401 UNAUTHENTICATED with a correlation id; bad token -> 401', async () => {
    const api = createHandler(deps());
    const res = await send(api, 'GET', '/me/trips');
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    expect(res.headers['x-correlation-id']).toEqual(expect.any(String));
    const bad = await send(api, 'GET', '/me/trips', { token: 'not.a.jwt' });
    expect(bad.status).toBe(401);
  });

  it('unknown route -> 404 ROUTE_NOT_FOUND', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/nope'],
      ['DELETE', '/trips'],
      ['GET', `/trips/${id}/extra/segments`],
      // Empty segments never match, and a trailing slash is not accepted (exact paths only).
      ['GET', `/trips//${id}`],
      ['GET', '//me/trips'],
      ['POST', '/trips//accept'],
      ['GET', '/me/trips/'],
      ['GET', 'me/trips'],
    ] as const) {
      const res = await send(api, method, path, { token: passenger.token });
      expect(res.status, path).toBe(404);
      expect(errorOf(res).code).toBe('ROUTE_NOT_FOUND');
    }
  });
});

describe('accept race', () => {
  it('two offered drivers accept at once: one wins, the loser gets 409', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const racers = [await driver(d), await driver(d)];
    for (const r of racers) {
      await send(api, 'PUT', '/drivers/me/position', { token: r.token, body: MEDELLIN });
      await send(api, 'PUT', '/drivers/me/availability', { token: r.token, body: { status: 'AVAILABLE' } });
    }
    const trip = await requestTrip(api, passenger, MEDELLIN);
    expect((await d.dispatch.offerTrip(trip.id, BASE)).sort()).toEqual(racers.map((r) => r.id).sort());

    const results = await Promise.all(racers.map((r) => send(api, 'POST', `/trips/${trip.id}/accept`, { token: r.token })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 200);
    expect(loser?.status).toBe(409);
    expect(loser === undefined ? '' : errorOf(loser).code).toBe('TRIP_ALREADY_TAKEN');
  });

  it('an offered driver accepting after another driver committed -> 409 TRIP_ALREADY_TAKEN; a never-offered driver -> 404', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const [d1, d2] = [await driver(d), await driver(d)];
    for (const r of [d1, d2]) {
      await send(api, 'PUT', '/drivers/me/position', { token: r.token, body: MANIZALES });
      await send(api, 'PUT', '/drivers/me/availability', { token: r.token, body: { status: 'AVAILABLE' } });
    }
    const trip = await requestTrip(api, passenger, MANIZALES);
    expect(await d.dispatch.offerTrip(trip.id, BASE)).toHaveLength(2);

    expect((await send(api, 'POST', `/trips/${trip.id}/accept`, { token: d1.token })).status).toBe(200);
    const late = await send(api, 'POST', `/trips/${trip.id}/accept`, { token: d2.token });
    expect(late.status).toBe(409);
    expect(errorOf(late).code).toBe('TRIP_ALREADY_TAKEN');
    // The loser still cannot read the trip, and a driver who was never offered learns nothing.
    expect((await send(api, 'GET', `/trips/${trip.id}`, { token: d2.token })).status).toBe(404);
    const stranger = await driver(d);
    const probe = await send(api, 'POST', `/trips/${trip.id}/accept`, { token: stranger.token });
    expect(probe.status).toBe(404);
    expect(errorOf(probe).code).toBe('TRIP_NOT_FOUND');
    expect((await d.trips.get(trip.id))?.driverId).toBe(d1.id);
  });

  it('an offered driver accepting a trip the passenger cancelled -> 409 INVALID_TRANSITION', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const drv = await driver(d);
    const at = north(MANIZALES, 100);
    await send(api, 'PUT', '/drivers/me/position', { token: drv.token, body: at });
    await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'AVAILABLE' } });
    const trip = await requestTrip(api, passenger, at);
    await d.dispatch.offerTrip(trip.id, BASE);
    expect((await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: passenger.token })).status).toBe(200);
    const res = await send(api, 'POST', `/trips/${trip.id}/accept`, { token: drv.token });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('INVALID_TRANSITION');
  });
});

describe('rating', () => {
  it('rating twice -> 409', async () => {
    const d = deps();
    const api = createHandler(d);
    const { passenger, trip } = await completedTrip(api, d, BOGOTA);
    expect((await send(api, 'POST', `/trips/${trip.id}/rating`, { token: passenger.token, body: { score: 4 } })).status).toBe(200);
    const again = await send(api, 'POST', `/trips/${trip.id}/rating`, { token: passenger.token, body: { score: 5 } });
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('INVALID_TRANSITION');
    expect((await d.trips.get(trip.id))?.rating).toEqual({ score: 4 });
  });

  it('rating more than 24 h after completion -> 422 RATING_WINDOW_CLOSED', async () => {
    const d = deps();
    const { passenger, trip } = await completedTrip(createHandler(d), d, north(BOGOTA, 100));
    const late = createHandler(deps(new Date(BASE.getTime() + DAY_MS + 60_000)));
    const res = await send(late, 'POST', `/trips/${trip.id}/rating`, { token: passenger.token, body: { score: 5 } });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('RATING_WINDOW_CLOSED');
    // Inside the window it still works.
    const onTime = createHandler(deps(new Date(BASE.getTime() + DAY_MS - 60_000)));
    expect((await send(onTime, 'POST', `/trips/${trip.id}/rating`, { token: passenger.token, body: { score: 5 } })).status).toBe(200);
  });

  it('score 4.5 -> 400 VALIDATION_ERROR', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const res = await send(api, 'POST', `/trips/${randomUUID()}/rating`, { token: passenger.token, body: { score: 4.5 } });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('cancel', () => {
  it('passenger cancels a REQUESTED trip: offers are retired', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const drv = await driver(d);
    const at = north(PASTO, 100);
    await send(api, 'PUT', '/drivers/me/position', { token: drv.token, body: at });
    await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'AVAILABLE' } });
    const trip = await requestTrip(api, passenger, at);
    await d.dispatch.offerTrip(trip.id, BASE);

    const res = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: passenger.token, body: { reason: 'Changed plans' } });
    expect(res.status).toBe(200);
    expect(tripOf(res)).toMatchObject({ state: 'CANCELLED', cancellation: { by: 'passenger', reason: 'Changed plans' } });
    expect((await send(api, 'GET', '/drivers/me/offers', { token: drv.token })).body.items).toEqual([]);
    expect((await send(api, 'GET', `/trips/${trip.id}`, { token: drv.token })).status).toBe(404);
  });

  it('assigned driver cancels without a body and goes back to AVAILABLE; an Idempotency-Key replays the response', async () => {
    const d = deps();
    const api = createHandler(d);
    const { drv, trip } = await acceptedTrip(api, d, north(NEIVA, 100));
    const key = randomUUID();
    const first = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: drv.token, headers: { 'idempotency-key': key } });
    expect(first.status).toBe(200);
    expect(tripOf(first)).toMatchObject({ state: 'CANCELLED', cancellation: { by: 'driver' } });
    expect((await d.drivers.get(drv.id))?.availability).toBe('AVAILABLE');

    const replay = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: drv.token, headers: { 'idempotency-key': key } });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    // Without the key the same request is a state conflict.
    const again = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: drv.token });
    expect(again.status).toBe(409);
  });
});

describe('Idempotency-Key on every mutating route', () => {
  it('accept and arrive with a key replay their response on retry instead of a state conflict', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const drv = await driver(d);
    const at = north(BOGOTA, 150);
    await send(api, 'PUT', '/drivers/me/position', { token: drv.token, body: at });
    await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'AVAILABLE' } });
    const trip = await requestTrip(api, passenger, at);
    expect(await d.dispatch.offerTrip(trip.id, BASE)).toContain(drv.id);

    const acceptKey = { token: drv.token, headers: { 'idempotency-key': randomUUID() } };
    const accepted = await send(api, 'POST', `/trips/${trip.id}/accept`, acceptKey);
    expect(accepted.status).toBe(200);
    const acceptReplay = await send(api, 'POST', `/trips/${trip.id}/accept`, acceptKey);
    expect(acceptReplay).toMatchObject({ status: 200, body: accepted.body, headers: { 'idempotent-replayed': 'true' } });

    const arriveKey = { token: drv.token, headers: { 'idempotency-key': randomUUID() } };
    const arrived = await send(api, 'POST', `/trips/${trip.id}/arrive`, arriveKey);
    expect(tripOf(arrived)).toMatchObject({ state: 'DRIVER_ARRIVED' });
    const arriveReplay = await send(api, 'POST', `/trips/${trip.id}/arrive`, arriveKey);
    expect(arriveReplay).toMatchObject({ status: 200, body: arrived.body, headers: { 'idempotent-replayed': 'true' } });
    // The same request without a key is a state conflict.
    expect((await send(api, 'POST', `/trips/${trip.id}/arrive`, { token: drv.token })).status).toBe(409);
  });

  it('keys are scoped by role: a driver with the passenger subject and key gets no replay of the passenger trip', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const trip = await requestTrip(api, passenger, north(PASTO, 150));
    const key = randomUUID();
    const cancelled = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: passenger.token, headers: { 'idempotency-key': key } });
    expect(cancelled.status).toBe(200);
    const sameSubDriver = await signToken({ id: passenger.id, role: 'driver' }, SECRET);
    const res = await send(api, 'POST', `/trips/${trip.id}/cancel`, { token: sameSubDriver, headers: { 'idempotency-key': key } });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('TRIP_NOT_FOUND');
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('PUT availability with a key replays the stored driver view', async () => {
    const d = deps();
    const api = createHandler(d);
    const drv = await driver(d);
    const call = { token: drv.token, headers: { 'idempotency-key': randomUUID() }, body: { status: 'AVAILABLE' } };
    const first = await send(api, 'PUT', '/drivers/me/availability', call);
    expect(first.body).toMatchObject({ id: drv.id, availability: 'AVAILABLE' });
    await send(api, 'PUT', '/drivers/me/availability', { token: drv.token, body: { status: 'OFFLINE' } });
    const replay = await send(api, 'PUT', '/drivers/me/availability', call);
    expect(replay).toMatchObject({ status: 200, body: first.body, headers: { 'idempotent-replayed': 'true' } });
    expect((await d.drivers.get(drv.id))?.availability).toBe('OFFLINE');
  });

  it('a reply lost after the trip commits: the retry replays the same trip and creates no second one', async () => {
    // The first Lambda sees its TransactWriteItems commit and then fails (lost reply / crash).
    const lostReply = {
      send: async (cmd: unknown) => {
        const out = await doc.send(cmd as never);
        if (cmd instanceof TransactWriteCommand) throw new Error('socket hang up after commit');
        return out;
      },
    } as unknown as DynamoDBDocumentClient;
    const crashed = createDeps({ doc: lostReply, table, jwtSecret: SECRET, now: () => BASE, log: () => undefined });
    const passenger = await person('passenger');
    const call = {
      token: passenger.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { origin: CALI, destination: north(CALI, 3) },
    };
    expect((await send(createHandler(crashed), 'POST', '/trips', call)).status).toBe(500);
    const api = createHandler(deps());
    const retry = await send(api, 'POST', '/trips', call);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    const history = await send(api, 'GET', '/me/trips', { token: passenger.token });
    expect(history.body.items).toEqual([retry.body]);
  });
});

describe('POST /trips idempotency and validation', () => {
  it('without Idempotency-Key -> 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const res = await send(api, 'POST', '/trips', { token: passenger.token, body: { origin: CALI, destination: north(CALI, 2) } });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('retry with the same key -> same trip id, 201, one trip in history; different body -> 422', async () => {
    const d = deps();
    const api = createHandler(d);
    const passenger = await person('passenger');
    const key = randomUUID();
    const at = north(CALI, 200);
    const first = await requestTrip(api, passenger, at, key);
    const retry = await send(api, 'POST', '/trips', {
      token: passenger.token,
      headers: { 'idempotency-key': key },
      body: { destination: north(at, 3), origin: at },
    });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(tripOf(retry)).toEqual(first);
    expect((await d.trips.history(passenger.id)).map((t) => t.id)).toEqual([first.id]);

    const reused = await send(api, 'POST', '/trips', {
      token: passenger.token,
      headers: { 'idempotency-key': key },
      body: { origin: at, destination: north(at, 5) },
    });
    expect(reused.status).toBe(422);
    expect(errorOf(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('second active trip -> 409 ACTIVE_TRIP_EXISTS and the key is not consumed', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const at = north(CALI, 300);
    await requestTrip(api, passenger, at);
    const key = randomUUID();
    for (let i = 0; i < 2; i++) {
      const res = await send(api, 'POST', '/trips', {
        token: passenger.token,
        headers: { 'idempotency-key': key },
        body: { origin: at, destination: north(at, 2) },
      });
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ACTIVE_TRIP_EXISTS');
    }
  });

  it('non-JSON body -> 400 INVALID_JSON; missing destination -> 400 VALIDATION_ERROR', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const headers = { 'idempotency-key': randomUUID() };
    const bad = await send(api, 'POST', '/trips', { token: passenger.token, headers, rawBody: '{"origin":' });
    expect(bad.status).toBe(400);
    expect(errorOf(bad).code).toBe('INVALID_JSON');
    const missing = await send(api, 'POST', '/trips', { token: passenger.token, headers, body: { origin: CALI } });
    expect(missing.status).toBe(400);
    expect(errorOf(missing)).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining('destination') });
  });
});

describe('errors and logging', () => {
  it('a non-domain error -> 500 INTERNAL with a generic body; the stack only goes to the log', async () => {
    class BrokenTrips extends TripRepo {
      override async history(): Promise<Trip[]> {
        throw new Error('boom: secret internals');
      }
    }
    const d = deps();
    const api = createHandler({ ...d, trips: new BrokenTrips(doc, table) });
    const passenger = await person('passenger');
    const res = await api(event('GET', '/me/trips', { token: passenger.token }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(String(res.body))).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(String(res.body)).not.toContain('boom');
    expect(String(res.body)).not.toContain('at ');
    expect(res.headers?.['x-correlation-id']).toEqual(expect.any(String));

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', code: 'INTERNAL', status: 500, path: '/me/trips' });
    expect(String(logs[0]?.stack)).toContain('boom: secret internals');
  });

  it('the correlation id of the request reaches the outbox event', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const res = await send(api, 'POST', '/trips', {
      token: passenger.token,
      headers: { 'x-correlation-id': 'corr-outbox-1', 'idempotency-key': randomUUID() },
      body: { origin: POPAYAN, destination: CALI },
    });
    expect(res.status).toBe(201);
    const outbox = await doc.send(new GetCommand({ TableName: table, Key: { PK: `TRIP#${tripOf(res).id}`, SK: 'EVENT#000001' } }));
    expect(outbox.Item).toMatchObject({ correlationId: 'corr-outbox-1', type: 'trip.requested' });
  });

  it('one JSON log line per request with the correlation id; never the token or the body', async () => {
    const api = createHandler(deps());
    const passenger = await person('passenger');
    const res = await send(api, 'POST', '/trips', {
      token: passenger.token,
      headers: { 'x-correlation-id': 'corr-123', 'idempotency-key': randomUUID() },
      body: { origin: { lat: 91, lng: 0 }, destination: CALI },
    });
    expect(res.status).toBe(400);
    expect(res.headers['x-correlation-id']).toBe('corr-123');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: 'warn',
      msg: 'request',
      correlationId: 'corr-123',
      method: 'POST',
      path: '/trips',
      status: 400,
      code: 'VALIDATION_ERROR',
      durationMs: expect.any(Number),
    });
    const line = JSON.stringify(logs[0]);
    expect(line).not.toContain(passenger.token);
    // Structural: no body field and none of the body's content (durationMs may contain any digits).
    expect(logs[0]).not.toHaveProperty('body');
    expect(line).not.toContain('"lat"');
    expect(line).not.toContain('origin');
  });

  it('an unsafe correlation id header is replaced by a fresh one', async () => {
    const api = createHandler(deps());
    const res = await send(api, 'GET', '/me/trips', { headers: { 'x-correlation-id': 'bad id\n{"level":"info"}' } });
    expect(res.headers['x-correlation-id']).not.toContain('bad');
    expect(logs[0]?.correlationId).toBe(res.headers['x-correlation-id']);
  });
});

describe('Lambda entry (src/http/lambda.ts)', () => {
  it('builds its dependencies from env at module init and serves requests', async () => {
    process.env.RIDECORE_TABLE = table;
    process.env.RIDECORE_JWT_SECRET = SECRET;
    const { handler: envHandler } = await import('../../src/http/lambda.ts');
    const passenger = await person('passenger');
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const res = await envHandler(event('GET', '/me/trips', { token: passenger.token }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(String(res.body))).toEqual({ items: [] });
      // The production logger writes one JSON line to stdout.
      expect(out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
        level: 'info',
        msg: 'request',
        method: 'GET',
        path: '/me/trips',
        status: 200,
        correlationId: res.headers?.['x-correlation-id'],
      });
    } finally {
      out.mockRestore();
    }
  });
});
