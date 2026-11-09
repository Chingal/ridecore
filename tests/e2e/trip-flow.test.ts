import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { useFlociEnv } from '../integration/helpers/table.ts';

/**
 * Full trip over real HTTP. The target is `RIDECORE_API_URL`: the Floci-deployed Lambda behind the
 * HTTP API (`make up` writes it to `.env.local`) or the local adapter (`npm run dev`, port 3000).
 * Both share the Floci table named by `RIDECORE_TABLE`, and tokens are signed with the same dev secret.
 */
useFlociEnv();
const API = (process.env.RIDECORE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const TABLE = process.env.RIDECORE_TABLE ?? 'ridecore';
const SECRET = process.env.RIDECORE_JWT_SECRET ?? '';
if (SECRET === '') throw new Error('RIDECORE_JWT_SECRET is not set: run through `make e2e` / `make e2e-local` (they load .env.example)');

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

const drivers: Person[] = [];

afterAll(async () => {
  // Leave the shared table tidy: the test driver goes offline so later runs never offer to it.
  for (const d of drivers) await deps.drivers.setAvailability(d.id, 'OFFLINE').catch(() => undefined);
});

describe(`trip flow over HTTP (${API})`, () => {
  it('request -> accept -> arrive -> start -> complete -> rate, with outbox EVENT#000001..000006', async () => {
    const passenger = await person('passenger');
    const drv = await person('driver');
    drivers.push(drv);
    // Driver registration is a seed concern, not an API route.
    await deps.drivers.upsert({
      id: drv.id,
      name: 'Driver E2E',
      vehicle: { plate: 'TST000', model: 'Demo sedan', category: 'STANDARD' },
      availability: 'OFFLINE',
    });

    expect((await call('PUT', '/drivers/me/position', drv, ORIGIN)).status).toBe(200);
    const online = await call('PUT', '/drivers/me/availability', drv, { status: 'AVAILABLE' });
    expect(online.status).toBe(200);
    expect(online.body).toMatchObject({ id: drv.id, availability: 'AVAILABLE', position: ORIGIN });

    const created = await call('POST', '/trips', passenger, { origin: ORIGIN, destination: DESTINATION }, { 'idempotency-key': randomUUID() });
    expect(created.status).toBe(201);
    const trip = tripOf(created);
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
