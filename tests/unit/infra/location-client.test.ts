import { describe, expect, it } from 'vitest';
import { createLocationClient, createLocationNearby, LOCATION_OVERFETCH, LocationUnavailableError } from '../../../src/infra/location/client.ts';
import type { Availability } from '../../../src/infra/dynamo/driver-repo.ts';

const KEY = 'dev-only-location-internal-key-change-me';

type Call = { url: string; auth: string | null };

function fakeFetch(respond: (url: string) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    if (init?.signal?.aborted) throw init.signal.reason;
    return await new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      Promise.resolve(respond(url)).then(resolve, reject);
    });
  }) as typeof fetch;
}

const ok = (drivers: { driverId: string }[]) =>
  new Response(JSON.stringify({ schemaVersion: 1, drivers: drivers.map((d) => ({ ...d, lat: 0, lng: 0, distanceM: 1, at: 'x' })) }), {
    status: 200,
  });

describe('createLocationClient', () => {
  it('sends the internal key and the query, and returns the ids in order', async () => {
    const calls: Call[] = [];
    const client = createLocationClient({ url: 'http://loc:8090/', key: KEY, fetch: fakeFetch(() => ok([{ driverId: 'd2' }, { driverId: 'd1' }]), calls) });
    await expect(client.nearby({ lat: 2.45, lng: -76.47 }, 50)).resolves.toEqual(['d2', 'd1']);
    expect(calls).toEqual([{ url: 'http://loc:8090/v1/nearby?lat=2.45&lng=-76.47&limit=50', auth: `Bearer ${KEY}` }]);
  });

  it.each([
    ['a 500', () => new Response('boom', { status: 500 })],
    ['bad JSON', () => new Response('not json', { status: 200 })],
    ['another schema version', () => new Response(JSON.stringify({ schemaVersion: 2, drivers: [] }), { status: 200 })],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('turns %s into LOCATION_UNAVAILABLE', async (_name, respond) => {
    const client = createLocationClient({ url: 'http://loc:8090', key: KEY, fetch: fakeFetch(respond) });
    await expect(client.nearby({ lat: 0, lng: 0 }, 5)).rejects.toBeInstanceOf(LocationUnavailableError);
  });

  // Review Focus 1: a slow location service fails fast, so the trip.requested message is retried.
  it('times out a hanging request', async () => {
    const client = createLocationClient({ url: 'http://loc:8090', key: KEY, timeoutMs: 100, fetch: fakeFetch(() => new Promise(() => {})) });
    const started = Date.now();
    await expect(client.nearby({ lat: 0, lng: 0 }, 5)).rejects.toMatchObject({ code: 'LOCATION_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('createLocationNearby', () => {
  // Review Focus 2: a driver the location service returns but who is not AVAILABLE is never offered.
  it('keeps only drivers still AVAILABLE in DynamoDB, in the location order, up to the limit', async () => {
    const asked: number[] = [];
    const states: Record<string, Availability> = { d1: 'ON_TRIP', d2: 'AVAILABLE', d3: 'OFFLINE', d4: 'AVAILABLE', d5: 'AVAILABLE' };
    const nearby = createLocationNearby(
      { nearby: async (_p, limit) => (asked.push(limit), ['d1', 'd2', 'd3', 'd4', 'gone', 'd5']) },
      { availabilityOf: async (ids) => new Map(ids.filter((id) => id in states).map((id) => [id, states[id] as Availability])) },
    );
    await expect(nearby.availableNear({ lat: 0, lng: 0 }, 2)).resolves.toEqual([{ id: 'd2' }, { id: 'd4' }]);
    expect(asked).toEqual([LOCATION_OVERFETCH]);
    expect(LOCATION_OVERFETCH).toBe(50);
  });

  it('does not read DynamoDB when nobody is near', async () => {
    let reads = 0;
    const nearby = createLocationNearby({ nearby: async () => [] }, { availabilityOf: async () => (reads++, new Map()) });
    await expect(nearby.availableNear({ lat: 0, lng: 0 }, 5)).resolves.toEqual([]);
    expect(reads).toBe(0);
  });
});
