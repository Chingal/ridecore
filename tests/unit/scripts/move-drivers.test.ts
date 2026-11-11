import { describe, expect, it } from 'vitest';
import { DEMO_CENTRE, DEMO_DRIVERS } from '../../../scripts/demo-drivers.ts';
import { loopPoint } from '../../../scripts/move-drivers.ts';

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
};

describe('loopPoint', () => {
  const start = { lat: 2.4419, lng: -76.6063 };

  it('starts at the driver position and stays within ~500 m of it', () => {
    expect(metres(loopPoint(start, 0), start)).toBeLessThan(1);
    for (let k = 0; k < 60; k++) expect(metres(loopPoint(start, k), start)).toBeLessThanOrEqual(500);
  });

  it('is deterministic and closes the loop', () => {
    expect(loopPoint(start, 7)).toEqual(loopPoint(start, 7));
    expect(metres(loopPoint(start, 36), start)).toBeLessThan(1);
  });

  it('moves a few tens of metres per step', () => {
    const d = metres(loopPoint(start, 3), loopPoint(start, 4));
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(100);
  });
});

describe('demo drivers', () => {
  it('are the six seeded drivers around the demo centre', () => {
    expect(DEMO_DRIVERS.map((d) => d.id)).toEqual(['driver-1', 'driver-2', 'driver-3', 'driver-4', 'driver-5', 'driver-6']);
    for (const d of DEMO_DRIVERS) expect(metres(d.position, DEMO_CENTRE)).toBeLessThan(500);
  });
});
