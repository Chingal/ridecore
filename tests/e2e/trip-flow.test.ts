import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';

/**
 * Full trip over real HTTP. The target is `RIDECORE_API_URL`: the Floci-deployed Lambda behind the
 * HTTP API (`make up` writes it to `.env.deploy`) or the local adapter (`make e2e-local`, port 3000).
 * Both share the Floci table named by `RIDECORE_TABLE`, and tokens are signed with the same dev secret.
 * Configuration comes from `scripts/load-env.ts` (Vitest e2e `setupFiles`): exported env, then
 * `.env.local`, then `.env.deploy`, then `.env.example`.
 */
function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set: ${hint}`);
  return value;
}
const API = required('RIDECORE_API_URL', "run 'make up' (writes .env.deploy) or export it").replace(/\/$/, '');
const TABLE = required('RIDECORE_TABLE', 'expected from .env.deploy or .env.example');
const SECRET = required('RIDECORE_JWT_SECRET', 'expected from .env.example');

const doc = createDocumentClient(createDynamoClient());
// Offering a trip to drivers is an asynchronous consumer of `trip.requested` (Plan 2); no HTTP route
// triggers it yet, so the test runs the same dispatch use case directly against the shared table.
const deps = createDeps({ doc, table: TABLE, jwtSecret: SECRET, log: () => undefined });

type Person = Actor & { token: string };
type Res = { status: number; body: Record<string, unknown> };

async function person(role: Actor['role']): Promise<Person> {
  const id = `e2e-${role}-${randomUUID()}`;
  return { id, role, token: await signToken({ id, role }, SECRET) };
}

async function call(method: string, path: string, who: Person, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

const tripOf = (res: Res) => res.body as unknown as Trip;

// Around Popayán centre, jittered per run so leftovers of earlier runs never sit on the same point.
const ORIGIN: LatLng = { lat: 2.4419 + (Math.random() - 0.5) * 0.004, lng: -76.6063 + (Math.random() - 0.5) * 0.004 };
const DESTINATION: LatLng = { lat: ORIGIN.lat + 0.03, lng: ORIGIN.lng + 0.01 };

/** What this run created in the shared table, so cleanup can undo it even after a failed assertion. */
const leftovers: { passenger?: Person; driver?: Person; tripId?: string } = {};

const ACTIVE = new Set(['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS']);

afterAll(async () => {
  // Leave the shared table tidy: no active trip left behind and the test driver OFFLINE, so later
  // runs never offer to it. Any cleanup failure fails the run instead of being swallowed.
  const failures: unknown[] = [];
  const { passenger, driver, tripId } = leftovers;
  if (tripId !== undefined) {
    try {
      const trip = await deps.trips.get(tripId);
      if (trip !== null && ACTIVE.has(trip.state)) {
        const now = new Date();
        if (trip.state === 'IN_PROGRESS' && driver !== undefined) {
          await deps.dispatch.finishTrip(tripId, { type: 'COMPLETE' }, driver, now);
        } else if (passenger !== undefined) {
          await deps.dispatch.finishTrip(tripId, { type: 'CANCEL', reason: 'e2e cleanup' }, passenger, now);
        }
      }
    } catch (err) {
      failures.push(err);
    }
  }
  if (driver !== undefined) {
    try {
      await deps.drivers.setAvailability(driver.id, 'OFFLINE');
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `e2e cleanup failed (${failures.length})`);
});

describe(`trip flow over HTTP (${API})`, () => {
  it('request -> accept -> arrive -> start -> complete -> rate, with outbox EVENT#000001..000006', async () => {
    const passenger = await person('passenger');
    const drv = await person('driver');
    leftovers.passenger = passenger;
    // Driver registration is a seed concern, not an API route.
    await deps.drivers.upsert({
      id: drv.id,
      name: 'Driver E2E',
      vehicle: { plate: 'TST000', model: 'Demo sedan', category: 'STANDARD' },
      availability: 'OFFLINE',
    });
    leftovers.driver = drv;

    expect((await call('PUT', '/drivers/me/position', drv, ORIGIN)).status).toBe(200);
    const online = await call('PUT', '/drivers/me/availability', drv, { status: 'AVAILABLE' });
    expect(online.status).toBe(200);
    expect(online.body).toMatchObject({ id: drv.id, availability: 'AVAILABLE', position: ORIGIN });

    const created = await call('POST', '/trips', passenger, { origin: ORIGIN, destination: DESTINATION }, { 'idempotency-key': randomUUID() });
    expect(created.status).toBe(201);
    const trip = tripOf(created);
    leftovers.tripId = trip.id;
    expect(trip).toMatchObject({ passengerId: passenger.id, state: 'REQUESTED', version: 1 });

    expect(await deps.dispatch.offerTrip(trip.id)).toContain(drv.id);
    const offers = await call('GET', '/drivers/me/offers', drv);
    expect(offers.status).toBe(200);
    expect((offers.body.items as Trip[]).map((t) => t.id)).toContain(trip.id);

    for (const [step, state] of [
      ['accept', 'ACCEPTED'],
      ['arrive', 'DRIVER_ARRIVED'],
      ['start', 'IN_PROGRESS'],
      ['complete', 'COMPLETED'],
    ] as const) {
      const res = await call('POST', `/trips/${trip.id}/${step}`, drv);
      expect(res.status, step).toBe(200);
      expect(tripOf(res)).toMatchObject({ state, driverId: drv.id });
    }

    const rated = await call('POST', `/trips/${trip.id}/rating`, passenger, { score: 5, comment: 'Smooth ride' });
    expect(rated.status).toBe(200);
    expect(tripOf(rated)).toMatchObject({ state: 'RATED', rating: { score: 5 }, version: 6 });

    const read = await call('GET', `/trips/${trip.id}`, passenger);
    expect(read.status).toBe(200);
    expect(tripOf(read).state).toBe('RATED');

    const outbox = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :event)',
        ExpressionAttributeValues: { ':pk': `TRIP#${trip.id}`, ':event': 'EVENT#' },
        ConsistentRead: true,
      }),
    );
    expect((outbox.Items ?? []).map((i) => i.SK)).toEqual([
      'EVENT#000001',
      'EVENT#000002',
      'EVENT#000003',
      'EVENT#000004',
      'EVENT#000005',
      'EVENT#000006',
    ]);
  });
});
