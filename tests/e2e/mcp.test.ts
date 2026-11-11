import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import type { Actor, LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';

/**
 * The MCP server as an agent runs it: a child process over stdio (so any stray stdout line would break
 * the session), calling the real HTTP API at `RIDECORE_API_URL` (Floci Lambda or the local adapter).
 */
function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set: ${hint}`);
  return value;
}
const API = required('RIDECORE_API_URL', "run 'make up' (writes .env.deploy) or export it").replace(/\/$/, '');
const TABLE = required('RIDECORE_TABLE', 'expected from .env.deploy or .env.example');
const SECRET = required('RIDECORE_JWT_SECRET', 'expected from .env.example');
const deps = createDeps({ doc: createDocumentClient(createDynamoClient()), table: TABLE, jwtSecret: SECRET, log: () => undefined });

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };

const clients: Client[] = [];
const passengers: Actor[] = [];

async function agent(actor: Actor): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', './scripts/load-env.ts', 'src/mcp/main.ts'],
    env: { ...(process.env as Record<string, string>), RIDECORE_MCP_TOKEN: await signToken(actor, SECRET) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ridecore-e2e', version: '0.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Result>;
const text = (r: Result) => r.content[0]?.text ?? '';

// Its own area near Popayán, jittered per run, away from the other e2e files.
const ORIGIN: LatLng = { lat: 2.43 + (Math.random() - 0.5) * 0.002, lng: -76.63 + (Math.random() - 0.5) * 0.002 };
const DESTINATION: LatLng = { lat: ORIGIN.lat + 0.015, lng: ORIGIN.lng + 0.01 };

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const p of passengers) {
    for (const trip of await deps.trips.history(p.id)) {
      if (['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED'].includes(trip.state)) {
        await deps.dispatch.finishTrip(trip.id, { type: 'CANCEL', reason: 'e2e cleanup' }, p, new Date());
      }
    }
  }
});

describe(`MCP server over stdio (${API})`, () => {
  it('request -> one active trip only -> status -> list -> cancel -> cannot cancel twice', async () => {
    const me: Actor = { id: `e2e-mcp-passenger-${randomUUID()}`, role: 'passenger' };
    passengers.push(me);
    const client = await agent(me);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_trip', 'get_trip_status', 'list_my_trips', 'request_trip']);

    const requested = await call(client, 'request_trip', { origin: ORIGIN, destination: DESTINATION });
    expect(requested.isError, text(requested)).toBeFalsy();
    const trip = requested.structuredContent as { tripId: string; state: string; driverAssigned: boolean; fareEstimate: number };
    expect(trip).toMatchObject({ state: 'REQUESTED', driverAssigned: false, currency: 'COP' });
    expect(trip.fareEstimate).toBeGreaterThan(0);

    const again = await call(client, 'request_trip', { origin: ORIGIN, destination: DESTINATION });
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/^ACTIVE_TRIP_EXISTS: /);

    const status = await call(client, 'get_trip_status', { trip_id: trip.tripId });
    expect(status.structuredContent).toMatchObject({ tripId: trip.tripId, state: 'REQUESTED' });

    const list = await call(client, 'list_my_trips');
    expect((list.structuredContent as { trips: { tripId: string }[] }).trips[0]?.tripId).toBe(trip.tripId);

    const cancelled = await call(client, 'cancel_trip', { trip_id: trip.tripId, reason: 'changed plans' });
    expect(cancelled.structuredContent).toMatchObject({ tripId: trip.tripId, state: 'CANCELLED', cancelledBy: 'passenger' });

    const twice = await call(client, 'cancel_trip', { trip_id: trip.tripId });
    expect(twice.isError).toBe(true);
    expect(text(twice)).toMatch(/^INVALID_TRANSITION: /);
  }, 120_000);

  it("never widens its token: a driver token gets FORBIDDEN_ROLE, another passenger's trip is TRIP_NOT_FOUND", async () => {
    const driver = await agent({ id: `e2e-mcp-driver-${randomUUID()}`, role: 'driver' });
    const asDriver = await call(driver, 'list_my_trips');
    expect(asDriver.isError).toBe(true);
    expect(text(asDriver)).toMatch(/^FORBIDDEN_ROLE: /);

    const other: Actor = { id: `e2e-mcp-other-${randomUUID()}`, role: 'passenger' };
    const me: Actor = { id: `e2e-mcp-passenger-${randomUUID()}`, role: 'passenger' };
    passengers.push(other, me);
    const res = await fetch(`${API}/trips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await signToken(other, SECRET)}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ origin: ORIGIN, destination: DESTINATION }),
    });
    expect(res.status).toBe(201);
    const theirs = (await res.json()) as Trip;

    const peek = await call(await agent(me), 'get_trip_status', { trip_id: theirs.id });
    expect(peek.isError).toBe(true);
    expect(text(peek)).toMatch(/^TRIP_NOT_FOUND: /);
  }, 120_000);
});
