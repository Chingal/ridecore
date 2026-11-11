import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../src/domain/errors.ts';
import type { LatLng, Trip } from '../../src/domain/trip.ts';
import { signToken } from '../../src/http/auth.ts';
import { createDeps } from '../../src/http/deps.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';

/**
 * Load actors (docs/load-testing.md): drivers and passengers with their own ids and their own area,
 * so a load run never touches seed, demo or e2e data. Setup writes `.load/actors.json` (git-ignored,
 * holds tokens); teardown ends every active trip of a load passenger and sets load drivers OFFLINE.
 */

/** Cell `d23tg`, east of Popayán: its 3 × 3 block shares no cell with DEMO_CENTRE's block. */
export const LOAD_CENTRE: LatLng = { lat: 2.45, lng: -76.47 };
export const LOAD_RADIUS_KM = 1.4;
/** Ids teardown tries when `.load/actors.json` is gone (after a crash): enough for every profile. */
export const MAX_ACTORS = 700;
export const ACTORS_FILE = '.load/actors.json';

export type LoadDriver = { id: string; position: LatLng };
export type LoadPassenger = { id: string; position: LatLng };
export type ActorsFile = {
  drivers: (LoadDriver & { token: string })[];
  passengers: (LoadPassenger & { token: string })[];
};

/** Small deterministic PRNG (mulberry32), so a seed gives the same actors every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointNear(centre: LatLng, rnd: () => number): LatLng {
  const r = LOAD_RADIUS_KM * Math.sqrt(rnd());
  const angle = 2 * Math.PI * rnd();
  const lat = centre.lat + (r * Math.cos(angle)) / 111.32;
  const lng = centre.lng + (r * Math.sin(angle)) / (111.32 * Math.cos((centre.lat * Math.PI) / 180));
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

export function planActors(drivers: number, passengers: number, seed: number): { drivers: LoadDriver[]; passengers: LoadPassenger[] } {
  const rnd = random(seed);
  return {
    drivers: Array.from({ length: drivers }, (_, i) => ({ id: `load-driver-${i + 1}`, position: pointNear(LOAD_CENTRE, rnd) })),
    passengers: Array.from({ length: passengers }, (_, i) => ({ id: `load-passenger-${i + 1}`, position: pointNear(LOAD_CENTRE, rnd) })),
  };
}

export type TeardownDeps = {
  activeTrip(passengerId: string): Promise<Trip | null>;
  cancel(trip: Trip, passengerId: string): Promise<void>;
  complete(trip: Trip, driverId: string): Promise<void>;
  setOffline(driverId: string): Promise<'done' | 'missing' | 'on_trip'>;
};

export type TeardownResult = { cancelled: number; completed: number; offline: number; missing: number; stuck: string[]; failed: string[] };

/** Ends every active trip of the passengers, then sets the drivers OFFLINE. Safe to run again. */
export async function teardownActors(ids: { drivers: string[]; passengers: string[] }, deps: TeardownDeps): Promise<TeardownResult> {
  const result: TeardownResult = { cancelled: 0, completed: 0, offline: 0, missing: 0, stuck: [], failed: [] };
  // One failing actor (a Lambda still acting after k6 stopped) must not leave the rest behind.
  const attempt = async (who: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      result.failed.push(`${who}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const passengerId of ids.passengers) {
    await attempt(passengerId, async () => {
      const trip = await deps.activeTrip(passengerId);
      if (trip === null) return;
      // Cancelling is allowed up to DRIVER_ARRIVED; an IN_PROGRESS trip can only be completed by its driver.
      if (trip.state === 'IN_PROGRESS' && trip.driverId !== undefined) {
        await deps.complete(trip, trip.driverId);
        result.completed++;
      } else {
        await deps.cancel(trip, passengerId);
        result.cancelled++;
      }
    });
  }
  for (const driverId of ids.drivers) {
    await attempt(driverId, async () => {
      const outcome = await deps.setOffline(driverId);
      if (outcome === 'done') result.offline++;
      else if (outcome === 'missing') result.missing++;
      else result.stuck.push(driverId);
    });
  }
  return result;
}

export type SetupDeps = {
  sign(id: string, role: 'driver' | 'passenger'): Promise<string>;
  write(file: ActorsFile): void;
  upsert(driver: LoadDriver, n: number): Promise<void>;
};

/**
 * Writes the actors file (ids and tokens) first, then creates the drivers. A setup that fails
 * halfway therefore leaves a file naming every driver it may have created, so teardown finds them.
 */
export async function setupActors(plan: { drivers: LoadDriver[]; passengers: LoadPassenger[] }, deps: SetupDeps): Promise<ActorsFile> {
  const file: ActorsFile = {
    drivers: await Promise.all(plan.drivers.map(async (d) => ({ ...d, token: await deps.sign(d.id, 'driver') }))),
    passengers: await Promise.all(plan.passengers.map(async (p) => ({ ...p, token: await deps.sign(p.id, 'passenger') }))),
  };
  deps.write(file);
  for (const [i, d] of plan.drivers.entries()) await deps.upsert(d, i + 1);
  return file;
}

function realDeps() {
  const table = process.env.RIDECORE_TABLE;
  const secret = process.env.RIDECORE_JWT_SECRET;
  if (!table || !secret) throw new Error("RIDECORE_TABLE and RIDECORE_JWT_SECRET are required: run 'make up' first");
  return { deps: createDeps({ doc: createDocumentClient(createDynamoClient()), table, jwtSecret: secret, log: () => undefined }), secret };
}

async function setup(drivers: number, passengers: number, seed: number): Promise<void> {
  const { deps, secret } = realDeps();
  mkdirSync('.load', { recursive: true });
  await setupActors(planActors(drivers, passengers, seed), {
    sign: (id, role) => signToken({ id, role }, secret),
    write: (file) => writeFileSync(ACTORS_FILE, JSON.stringify(file)),
    upsert: async (d, n) => {
      try {
        await deps.drivers.upsert({
          id: d.id,
          name: `Load driver ${n}`,
          vehicle: { plate: `LOAD${String(n).padStart(3, '0')}`, model: 'Load sedan', category: 'STANDARD' },
          availability: 'AVAILABLE',
          position: d.position,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DRIVER_ON_TRIP') throw new Error(`${d.id} is on a trip: run 'make load-teardown' first`, { cause: err });
        throw err;
      }
    },
  });
  console.log(`load setup: ${drivers} drivers AVAILABLE and ${passengers} passengers around (${LOAD_CENTRE.lat}, ${LOAD_CENTRE.lng}); tokens in ${ACTORS_FILE}`);
}

async function teardown(): Promise<void> {
  const { deps } = realDeps();
  const now = () => new Date();
  const range = (prefix: string) => Array.from({ length: MAX_ACTORS }, (_, i) => `${prefix}${i + 1}`);
  const ids = existsSync(ACTORS_FILE)
    ? (() => {
        const f = JSON.parse(readFileSync(ACTORS_FILE, 'utf8')) as ActorsFile;
        return { drivers: f.drivers.map((d) => d.id), passengers: f.passengers.map((p) => p.id) };
      })()
    : { drivers: range('load-driver-'), passengers: range('load-passenger-') };
  const result = await teardownActors(ids, {
    // The reservation item is the source of truth for "active" (consistent read), not the history index.
    activeTrip: async (passengerId) => {
      const tripId = await deps.trips.activeTripId('PASSENGER', passengerId);
      return tripId === null ? null : deps.trips.get(tripId);
    },
    cancel: async (trip, passengerId) => {
      await deps.dispatch.finishTrip(trip.id, { type: 'CANCEL', reason: 'load teardown' }, { id: passengerId, role: 'passenger' }, now());
    },
    complete: async (trip, driverId) => {
      await deps.dispatch.finishTrip(trip.id, { type: 'COMPLETE' }, { id: driverId, role: 'driver' }, now());
    },
    setOffline: async (driverId) => {
      try {
        await deps.drivers.setAvailability(driverId, 'OFFLINE');
        return 'done';
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DRIVER_NOT_FOUND') return 'missing';
        if (err instanceof DomainError && err.code === 'DRIVER_ON_TRIP') return 'on_trip';
        throw err;
      }
    },
  });
  console.log(
    `load teardown: ${result.cancelled} trips cancelled, ${result.completed} completed, ${result.offline} drivers OFFLINE` +
      (result.stuck.length > 0 ? `; still ON_TRIP: ${result.stuck.join(', ')}` : '') +
      (result.failed.length > 0 ? `; failed: ${result.failed.join('; ')}` : ''),
  );
  if (result.stuck.length > 0 || result.failed.length > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, a, b, c] = process.argv.slice(2);
  try {
    if (command === 'setup') await setup(Number(a ?? 20), Number(b ?? 40), Number(c ?? 1));
    else if (command === 'teardown') await teardown();
  } catch (err) {
    console.error(`load ${command}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (command !== 'setup' && command !== 'teardown') {
    console.error('Usage: node scripts/load/actors.ts setup <drivers> <passengers> [seed] | teardown');
    process.exit(1);
  }
}
