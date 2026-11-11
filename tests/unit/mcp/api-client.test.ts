import { describe, expect, it } from 'vitest';
import type { Trip } from '../../../src/domain/trip.ts';
import { ApiError, createApiClient } from '../../../src/mcp/api-client.ts';

const BASE = 'http://api.test/dev';
const TOKEN = 'tok.en-secret';
const ORIGIN = { lat: 2.4448, lng: -76.6147 };
const DESTINATION = { lat: 2.4594, lng: -76.5996 };
const TRIP = { id: 't-1', state: 'REQUESTED' } as unknown as Trip;

type Call = { method: string; url: string; headers: Record<string, string>; body: string | undefined };

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (respond: () => Response | Promise<Response>, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) => {
  const f = fakeFetch(respond);
  let n = 0;
  const api = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: f.fetch, newKey: () => `key-${++n}`, ...extra });
  return { api, calls: f.calls };
};

describe('createApiClient', () => {
  it('requestTrip posts the trip with the bearer token and a fresh Idempotency-Key', async () => {
    const { api, calls } = client(() => json(201, TRIP));
    expect(await api.requestTrip({ origin: ORIGIN, destination: DESTINATION })).toEqual(TRIP);
    await api.requestTrip({ origin: ORIGIN, destination: DESTINATION });
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${BASE}/trips`,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify({ origin: ORIGIN, destination: DESTINATION }),
    });
    expect(calls[1]?.headers['idempotency-key']).toBe('key-2');
  });

  it('uses a random UUID per request by default', async () => {
    const f = fakeFetch(() => json(201, TRIP));
    const api = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: f.fetch });
    await api.requestTrip({ origin: ORIGIN, destination: DESTINATION });
    await api.requestTrip({ origin: ORIGIN, destination: DESTINATION });
    const [a, b] = f.calls.map((c) => c.headers['idempotency-key']);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('getTrip encodes the id and does not double a trailing slash', async () => {
    const { api, calls } = client(() => json(200, TRIP), { baseUrl: `${BASE}/` });
    await api.getTrip('a/b');
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/trips/a%2Fb`, body: undefined });
    expect(calls[0]?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it('cancelTrip sends the reason as JSON, or no body without one', async () => {
    const { api, calls } = client(() => json(200, TRIP));
    await api.cancelTrip('t-1', 'late');
    await api.cancelTrip('t-1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/trips/t-1/cancel`, body: '{"reason":"late"}' });
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BASE}/trips/t-1/cancel`, body: undefined });
    expect(calls[1]?.headers['content-type']).toBeUndefined();
  });

  it('listMyTrips returns the items', async () => {
    const { api, calls } = client(() => json(200, { items: [TRIP] }));
    expect(await api.listMyTrips()).toEqual([TRIP]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/me/trips` });
  });

  it('turns the API error body into an ApiError', async () => {
    const { api } = client(() => json(404, { error: { code: 'TRIP_NOT_FOUND', message: 'Trip not found' } }));
    const err = await api.getTrip('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'TRIP_NOT_FOUND', message: 'Trip not found' });
  });

  it('a non-JSON error is API_ERROR with its status', async () => {
    const { api } = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(api.listMyTrips()).rejects.toMatchObject({ status: 502, code: 'API_ERROR' });
  });

  it('a refused connection or a timeout is API_UNAVAILABLE, naming the URL and never the token', async () => {
    const refused = client(() => Promise.reject(new TypeError('fetch failed')));
    const hanging = client(
      () => new Promise<Response>(() => undefined),
      { timeoutMs: 50 },
    );
    for (const { api } of [refused, hanging]) {
      const err = (await api.listMyTrips().catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: 'API_UNAVAILABLE' });
      expect(err.message).toContain('http://api.test/dev');
      expect(err.message).not.toContain(TOKEN);
    }
  });
});
