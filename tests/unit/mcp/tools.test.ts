import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LatLng, Trip } from '../../../src/domain/trip.ts';
import { type ApiClient, ApiError } from '../../../src/mcp/api-client.ts';
import { createMcpServer, summarize } from '../../../src/mcp/tools.ts';

const ORIGIN: LatLng = { lat: 2.4448, lng: -76.6147 };
const DESTINATION: LatLng = { lat: 2.4594, lng: -76.5996 };

const trip = (over: Partial<Trip> = {}): Trip => ({
  id: 't-1',
  passengerId: 'p-1',
  serviceType: 'STANDARD',
  origin: ORIGIN,
  destination: DESTINATION,
  state: 'REQUESTED',
  fareEstimate: 8000,
  timestamps: { REQUESTED: '2026-11-11T12:00:00.000Z' },
  version: 1,
  createdAt: '2026-11-11T12:00:00.000Z',
  ...over,
});

let calls: [string, unknown[]][];
let failWith: unknown;
let client: Client;

const fakeApi: ApiClient = {
  requestTrip: async (...a) => (calls.push(['requestTrip', a]), maybeFail(), trip()),
  getTrip: async (...a) => (calls.push(['getTrip', a]), maybeFail(), trip()),
  cancelTrip: async (...a) => (calls.push(['cancelTrip', a]), maybeFail(), trip({ state: 'CANCELLED', cancellation: { by: 'passenger', reason: 'x' } })),
  listMyTrips: async (...a) => (calls.push(['listMyTrips', a]), maybeFail(), [trip({ id: 't-2' }), trip({ id: 't-1' })]),
};
function maybeFail() {
  if (failWith !== undefined) throw failWith;
}

beforeEach(async () => {
  calls = [];
  failWith = undefined;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(fakeApi).connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
});
afterEach(async () => client.close());

const callTool = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown }>;

/** A rejected input is either a protocol error or an isError result; either way the API is not called. */
async function rejected(name: string, args: Record<string, unknown>) {
  const res = await callTool(name, args).catch(() => ({ isError: true }));
  expect(res.isError).toBe(true);
}

describe('summarize', () => {
  it("keeps what a passenger asks about and drops other people's ids and internals", () => {
    const s = summarize(trip({ state: 'COMPLETED', driverId: 'd-9', finalFare: 9100, rating: { score: 5, comment: 'ok' }, version: 5 }));
    expect(s).toEqual({
      tripId: 't-1',
      state: 'COMPLETED',
      origin: ORIGIN,
      destination: DESTINATION,
      fareEstimate: 8000,
      finalFare: 9100,
      currency: 'COP',
      driverAssigned: true,
      createdAt: '2026-11-11T12:00:00.000Z',
      timestamps: { REQUESTED: '2026-11-11T12:00:00.000Z' },
    });
    for (const key of ['passengerId', 'driverId', 'version', 'rating']) expect(Object.keys(s)).not.toContain(key);
  });

  it('a cancelled trip says who cancelled, not the reason', () => {
    const s = summarize(trip({ state: 'CANCELLED', cancellation: { by: 'driver', reason: 'flat tyre' } }));
    expect(s).toMatchObject({ cancelledBy: 'driver', driverAssigned: false });
    expect(JSON.stringify(s)).not.toContain('flat tyre');
  });
});

describe('MCP tools', () => {
  it('exposes exactly the four passenger tools, with examples in their descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_trip', 'get_trip_status', 'list_my_trips', 'request_trip']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));
    expect(byName.request_trip).toContain('"lat"');
    expect(byName.get_trip_status).toContain('trip_id');
    expect(byName.cancel_trip).toContain('trip_id');
    expect(byName.cancel_trip).toContain('IN_PROGRESS');
  });

  it('request_trip calls the API and returns the summary', async () => {
    const res = await callTool('request_trip', { origin: ORIGIN, destination: DESTINATION });
    expect(calls).toEqual([['requestTrip', [{ origin: ORIGIN, destination: DESTINATION }]]]);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(summarize(trip()));
    expect(JSON.parse(res.content[0]?.text ?? '')).toEqual(summarize(trip()));
  });

  it('get_trip_status and cancel_trip pass the trip id and reason', async () => {
    await callTool('get_trip_status', { trip_id: 't-1' });
    const res = await callTool('cancel_trip', { trip_id: 't-1', reason: 'changed plans' });
    await callTool('cancel_trip', { trip_id: 't-1' });
    expect(calls).toEqual([
      ['getTrip', ['t-1']],
      ['cancelTrip', ['t-1', 'changed plans']],
      ['cancelTrip', ['t-1', undefined]],
    ]);
    expect(res.structuredContent).toMatchObject({ state: 'CANCELLED', cancelledBy: 'passenger' });
  });

  it('list_my_trips returns the trips in the order the API gave', async () => {
    const res = await callTool('list_my_trips');
    expect((res.structuredContent as { trips: { tripId: string }[] }).trips.map((t) => t.tripId)).toEqual(['t-2', 't-1']);
  });

  it('rejects invalid input before calling the API', async () => {
    await rejected('get_trip_status', { trip_id: '' });
    await rejected('get_trip_status', { trip_id: 'x'.repeat(129) });
    await rejected('request_trip', { origin: { lat: 91, lng: 0 }, destination: DESTINATION });
    await rejected('cancel_trip', { trip_id: 't-1', reason: 'r'.repeat(201) });
    expect(calls).toEqual([]);
  });

  it('an API error comes back as a readable tool error', async () => {
    failWith = new ApiError(409, 'INVALID_TRANSITION', 'Cannot CANCEL a trip in state IN_PROGRESS');
    const res = await callTool('cancel_trip', { trip_id: 't-1' });
    expect(res).toMatchObject({ isError: true, content: [{ type: 'text', text: 'INVALID_TRANSITION: Cannot CANCEL a trip in state IN_PROGRESS' }] });
  });

  it('any other error is INTERNAL, with no detail for the model', async () => {
    failWith = new Error('boom at /secret/path');
    const res = await callTool('list_my_trips');
    expect(res).toMatchObject({ isError: true, content: [{ type: 'text', text: 'INTERNAL: unexpected error' }] });
  });
});
