import { fileURLToPath } from 'node:url';
import type { Actor, LatLng, Trip } from '../src/domain/trip.ts';
import { signToken } from '../src/http/auth.ts';
import { DEMO_CENTRE, DEMO_DRIVERS } from './demo-drivers.ts';

/**
 * `make demo`: one whole trip through the HTTP API, printed step by step. The offer reaches a driver
 * only through the dispatch consumer and the final fare only through billing, so the run also shows
 * the event path working. Uses the seeded `passenger-1` and drivers; tokens are never printed.
 */
export type DemoDeps = {
  api: string;
  secret: string;
  fetch?: typeof fetch;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const PASSENGER = 'passenger-1';
const DESTINATION: LatLng = { lat: DEMO_CENTRE.lat + 0.015, lng: DEMO_CENTRE.lng + 0.008 };
const ACTIVE = new Set(['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS']);
const POLL_MS = 1000;

class CallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function runDemoTrip(deps: DemoDeps): Promise<void> {
  const api = deps.api.replace(/\/+$/, '');
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const started = Date.now();
  const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`;
  const say = (line: string) => deps.print(`${stamp()} ${line}`);

  const tokens = new Map<string, string>();
  const tokenOf = async (actor: Actor) => {
    const key = `${actor.role}:${actor.id}`;
    if (!tokens.has(key)) tokens.set(key, await signToken(actor, deps.secret));
    return tokens.get(key) as string;
  };
  const passenger: Actor = { id: PASSENGER, role: 'passenger' };
  const driver = (id: string): Actor => ({ id, role: 'driver' });

  async function call<T>(who: Actor, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await doFetch(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await tokenOf(who)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!res.ok) throw new CallError(parsed.error?.code ?? `HTTP_${res.status}`, `${method} ${path}: ${parsed.error?.message ?? res.status}`);
    return parsed as T;
  }

  /** Polls `check` every second until it returns a value; past the timeout, fails with `hint`. */
  async function waitFor<T>(check: () => Promise<T | undefined>, hint: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await check();
      if (found !== undefined) return found;
      if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s: ${hint}`);
      await sleep(POLL_MS);
    }
  }

  // 1. Seeded drivers back to their seed position and AVAILABLE (a driver on a trip is left alone).
  for (const d of DEMO_DRIVERS) {
    try {
      await call(driver(d.id), 'PUT', '/drivers/me/position', d.position);
      await call(driver(d.id), 'PUT', '/drivers/me/availability', { status: 'AVAILABLE' });
    } catch (err) {
      if (!(err instanceof CallError && err.code === 'DRIVER_ON_TRIP')) throw err;
      say(`${d.id} is on a trip, left as it is`);
    }
  }

  // 2. One active trip per passenger: cancel a leftover from an earlier run.
  const { items: history } = await call<{ items: Trip[] }>(passenger, 'GET', '/me/trips');
  const leftover = history.find((t) => ACTIVE.has(t.state));
  if (leftover !== undefined) {
    await call(passenger, 'POST', `/trips/${leftover.id}/cancel`, { reason: 'demo reset' });
    say(`cancelled ${PASSENGER}'s earlier trip ${leftover.id.slice(0, 8)} (demo reset)`);
  }

  // 3. Request.
  let trip = await call<Trip>(passenger, 'POST', '/trips', { origin: DEMO_CENTRE, destination: DESTINATION }, { 'idempotency-key': crypto.randomUUID() });
  say(`${PASSENGER.padEnd(11)} request      -> ${trip.state.padEnd(15)} v${trip.version}  trip ${trip.id.slice(0, 8)}, fare estimate ${trip.fareEstimate} COP`);

  // 4. The offer arrives through the dispatch consumer.
  const offered = await waitFor(async () => {
    for (const d of DEMO_DRIVERS) {
      const { items } = await call<{ items: Trip[] }>(driver(d.id), 'GET', '/drivers/me/offers');
      if (items.some((o) => o.id === trip.id)) return d.id;
    }
    return undefined;
  }, 'no driver got the offer. Check the dispatch queue and its DLQ (make redrive QUEUE=dispatch).');
  say(`${offered.padEnd(11)} got the offer (through the dispatch consumer)`);

  // 5. The trip, step by step.
  const steps: [Actor, string, string][] = [
    [driver(offered), 'accept', 'accept'],
    [driver(offered), 'arrive', 'arrive'],
    [driver(offered), 'start', 'start'],
    [driver(offered), 'complete', 'complete'],
  ];
  for (const [who, action, path] of steps) {
    trip = await call<Trip>(who, 'POST', `/trips/${trip.id}/${path}`);
    say(`${who.id.padEnd(11)} ${action.padEnd(12)} -> ${trip.state.padEnd(15)} v${trip.version}`);
  }
  trip = await call<Trip>(passenger, 'POST', `/trips/${trip.id}/rating`, { score: 5 });
  say(`${PASSENGER.padEnd(11)} rate 5       -> ${trip.state.padEnd(15)} v${trip.version}`);

  // 6. The final fare arrives through the billing consumer.
  const fare = await waitFor(async () => (await call<Trip>(passenger, 'GET', `/trips/${trip.id}`)).finalFare, 'no final fare. Check the billing queue and its DLQ (make redrive QUEUE=billing).');
  say(`billing     final fare ${fare} COP (through the billing consumer)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const api = process.env.RIDECORE_API_URL;
  const secret = process.env.RIDECORE_JWT_SECRET;
  if (!api || !secret) {
    console.error("RIDECORE_API_URL and RIDECORE_JWT_SECRET are required: run 'make up' first");
    process.exit(1);
  }
  try {
    await runDemoTrip({ api, secret, print: (line) => console.log(line) });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
