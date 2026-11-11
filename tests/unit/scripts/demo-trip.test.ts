import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDemoTrip } from '../../../scripts/demo-trip.ts';

const API = 'http://api.test';
const SECRET = 'unit-test-secret-unit-test-secret';
const OFFERED_TO = 'driver-3';

type Req = { method: string; path: string; who: string; body: unknown };

let requests: Req[];
let printed: string[];
let activeTrip: boolean;
let busyDriver: string | undefined;
let offerAfterPolls: number;
let fareAfterPolls: number;

/** A tiny in-memory API: just enough of the routes the demo calls. */
function fakeFetch(): typeof fetch {
  let state = 'REQUESTED';
  let version = 1;
  let offerPolls = 0;
  let farePolls = 0;
  const trip = () => ({
    id: 'trip-1',
    state,
    version,
    fareEstimate: 8202,
    ...(state === 'RATED' && farePolls >= fareAfterPolls ? { finalFare: 8202 } : {}),
  });
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(API.length);
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const who = decodeJwt(auth.replace('Bearer ', '')).sub ?? '?';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ method, path, who, body });

    if (path === '/drivers/me/availability' && who === busyDriver) {
      return reply(409, { error: { code: 'DRIVER_ON_TRIP', message: 'The driver is on a trip' } });
    }
    if (path.startsWith('/drivers/me/')) {
      if (path === '/drivers/me/offers') {
        if (who === OFFERED_TO) offerPolls++;
        return reply(200, { items: who === OFFERED_TO && offerPolls > offerAfterPolls ? [trip()] : [] });
      }
      return reply(200, {});
    }
    if (path === '/me/trips') return reply(200, { items: activeTrip ? [{ id: 'old-trip', state: 'ACCEPTED' }] : [] });
    if (path === '/trips/old-trip/cancel') return reply(200, { id: 'old-trip', state: 'CANCELLED' });
    if (path === '/trips' && method === 'POST') return reply(201, trip());
    const step = /^\/trips\/trip-1\/(accept|arrive|start|complete|rating)$/.exec(path)?.[1];
    if (step !== undefined) {
      const next: Record<string, string> = { accept: 'ACCEPTED', arrive: 'DRIVER_ARRIVED', start: 'IN_PROGRESS', complete: 'COMPLETED', rating: 'RATED' };
      state = next[step] ?? state;
      version++;
      return reply(200, trip());
    }
    if (path === '/trips/trip-1') {
      farePolls++;
      return reply(200, trip());
    }
    return reply(404, { error: { code: 'ROUTE_NOT_FOUND', message: path } });
  }) as typeof fetch;
}

const run = (timeoutMs = 60_000) =>
  runDemoTrip({ api: API, secret: SECRET, fetch: fakeFetch(), print: (l) => void printed.push(l), sleep: async () => undefined, timeoutMs });

beforeEach(() => {
  requests = [];
  printed = [];
  activeTrip = false;
  busyDriver = undefined;
  offerAfterPolls = 2;
  fareAfterPolls = 2;
});

describe('runDemoTrip', () => {
  it('drives a whole trip and prints each state, the offered driver and the final fare, never a token', async () => {
    await run();
    const out = printed.join('\n');
    const order = ['REQUESTED', OFFERED_TO, 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'RATED', 'final fare'];
    const positions = order.map((word) => out.indexOf(word));
    expect(positions.every((p) => p >= 0), out).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(out).not.toContain('eyJ');
    expect(requests.find((r) => r.path === '/trips/trip-1/rating')).toMatchObject({ who: 'passenger-1', body: { score: 5 } });
    expect(requests.filter((r) => /accept|arrive|start|complete$/.test(r.path)).every((r) => r.who === OFFERED_TO)).toBe(true);
  });

  it("cancels passenger-1's active trip before requesting a new one", async () => {
    activeTrip = true;
    await run();
    const cancel = requests.findIndex((r) => r.path === '/trips/old-trip/cancel');
    const request = requests.findIndex((r) => r.path === '/trips' && r.method === 'POST');
    expect(requests[cancel]?.body).toEqual({ reason: 'demo reset' });
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(request);
  });

  it('skips a seeded driver that is on a trip and carries on', async () => {
    busyDriver = 'driver-1';
    await run();
    expect(printed.join('\n')).toMatch(/driver-1.*on a trip/);
    expect(printed.join('\n')).toContain('RATED');
  });

  it('gives up with a pointer to the dispatch queue when no offer arrives', async () => {
    offerAfterPolls = Number.POSITIVE_INFINITY;
    await expect(run(0)).rejects.toThrow('make redrive QUEUE=dispatch');
  });
});
