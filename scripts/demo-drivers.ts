import type { LatLng } from '../src/domain/trip.ts';

/** Centre of the demo data (Popayán). Shared by the seed, the map demo and the car mover. */
export const DEMO_CENTRE: LatLng = { lat: 2.4419, lng: -76.6063 };

// Offsets of a few hundred metres, all inside the centre's geohash-5 cell or its neighbours.
const OFFSETS: readonly [number, number][] = [
  [0.002, 0.001],
  [-0.0015, 0.002],
  [0.001, -0.0025],
  [-0.0025, -0.001],
  [0.003, -0.0005],
  [-0.0005, 0.003],
];

/** The seeded drivers (`driver-1` … `driver-6`) and where the seed puts them. */
export const DEMO_DRIVERS: readonly { id: string; n: number; position: LatLng }[] = OFFSETS.map(([dLat, dLng], i) => ({
  id: `driver-${i + 1}`,
  n: i + 1,
  position: { lat: DEMO_CENTRE.lat + dLat, lng: DEMO_CENTRE.lng + dLng },
}));
