import ngeohash from 'ngeohash';
import { describe, expect, it } from 'vitest';
import type { Trip, TripState } from '../../../src/domain/trip.ts';
import { haversineKm } from '../../../src/domain/fare.ts';
import { cellOf } from '../../../src/infra/dynamo/driver-repo.ts';
import { DEMO_CENTRE } from '../../../scripts/demo-drivers.ts';
import { LOAD_CENTRE, planActors, teardownActors, type TeardownDeps } from '../../../scripts/load/actors.ts';

const block = (cell: string) => new Set([cell, ...ngeohash.neighbors(cell)]);

describe('planActors', () => {
  it('is deterministic for a seed, with load ids', () => {
    const a = planActors(20, 40, 7);
    expect(planActors(20, 40, 7)).toEqual(a);
    expect(a.drivers.map((d) => d.id).slice(0, 2)).toEqual(['load-driver-1', 'load-driver-2']);
    expect(a.passengers.at(-1)?.id).toBe('load-passenger-40');
    expect(a.drivers).toHaveLength(20);
  });

  it('keeps every actor within 1.5 km of LOAD_CENTRE, inside a block that never touches the demo block', () => {
    const load = block(cellOf(LOAD_CENTRE));
    const demo = block(cellOf(DEMO_CENTRE));
    expect([...load].some((c) => demo.has(c))).toBe(false);
    const { drivers, passengers } = planActors(100, 600, 1);
    for (const a of [...drivers, ...passengers]) {
      expect(haversineKm(LOAD_CENTRE, a.position)).toBeLessThanOrEqual(1.5);
      expect(load.has(cellOf(a.position))).toBe(true);
    }
  });
});

describe('teardownActors', () => {
  function fakes(trips: Record<string, { id: string; state: TripState; driverId?: string }>) {
    const calls: string[] = [];
    const offline = new Set<string>();
    const deps: TeardownDeps = {
      activeTrip: async (passengerId) => {
        const t = trips[passengerId];
        return t !== undefined && ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(t.state) ? (t as Trip) : null;
      },
      cancel: async (trip, passengerId) => {
        calls.push(`cancel ${trip.id} by ${passengerId}`);
        trips[passengerId] = { ...trips[passengerId]!, state: 'CANCELLED' };
      },
      complete: async (trip, driverId) => {
        calls.push(`complete ${trip.id} by ${driverId}`);
        const owner = Object.keys(trips).find((p) => trips[p]?.id === trip.id)!;
        trips[owner] = { ...trips[owner]!, state: 'COMPLETED' };
      },
      setOffline: async (driverId) => {
        if (driverId === 'load-driver-3') return 'missing';
        if (offline.has(driverId)) return 'done';
        offline.add(driverId);
        calls.push(`offline ${driverId}`);
        return 'done';
      },
    };
    return { deps, calls };
  }

  it('cancels cancellable trips, completes in-progress ones as their driver, then sets drivers offline; twice is a no-op', async () => {
    const { deps, calls } = fakes({
      'load-passenger-1': { id: 't1', state: 'REQUESTED' },
      'load-passenger-2': { id: 't2', state: 'DRIVER_ARRIVED', driverId: 'load-driver-1' },
      'load-passenger-3': { id: 't3', state: 'IN_PROGRESS', driverId: 'load-driver-2' },
      'load-passenger-4': { id: 't4', state: 'RATED' },
    });
    const ids = { drivers: ['load-driver-1', 'load-driver-2', 'load-driver-3'], passengers: ['load-passenger-1', 'load-passenger-2', 'load-passenger-3', 'load-passenger-4'] };
    const first = await teardownActors(ids, deps);
    expect(calls).toEqual([
      'cancel t1 by load-passenger-1',
      'cancel t2 by load-passenger-2',
      'complete t3 by load-driver-2',
      'offline load-driver-1',
      'offline load-driver-2',
    ]);
    expect(first).toEqual({ cancelled: 2, completed: 1, offline: 2, missing: 1, stuck: [] });
    calls.length = 0;
    expect(await teardownActors(ids, deps)).toEqual({ cancelled: 0, completed: 0, offline: 2, missing: 1, stuck: [] });
    expect(calls).toEqual([]);
  });
});
