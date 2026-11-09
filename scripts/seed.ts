import { DomainError } from '../src/domain/errors.ts';
import type { LatLng } from '../src/domain/trip.ts';
import { signToken } from '../src/http/auth.ts';
import { createDocumentClient } from '../src/infra/dynamo/client.ts';
import { DriverRepo } from '../src/infra/dynamo/driver-repo.ts';

/**
 * Demo data for local runs: 6 AVAILABLE drivers around Popayán centre and one passenger, plus
 * non-secret dev tokens for all of them. Idempotent: drivers have fixed ids and are replaced on
 * every run, except a driver currently on a trip, which is left as is.
 */
const table = process.env.RIDECORE_TABLE;
const secret = process.env.RIDECORE_JWT_SECRET;
if (!table || !secret) {
  console.error('RIDECORE_TABLE and RIDECORE_JWT_SECRET must be set (see .env.example)');
  process.exit(1);
}

const CENTRE: LatLng = { lat: 2.4419, lng: -76.6063 };
// Offsets of a few hundred metres, all inside the centre's geohash-5 cell or its neighbours.
const OFFSETS: readonly [number, number][] = [
  [0.002, 0.001],
  [-0.0015, 0.002],
  [0.001, -0.0025],
  [-0.0025, -0.001],
  [0.003, -0.0005],
  [-0.0005, 0.003],
];

const drivers = new DriverRepo(createDocumentClient(), table);
const tokens: { id: string; role: 'passenger' | 'driver'; name: string; token: string; note?: string }[] = [];

for (const [i, [dLat, dLng]] of OFFSETS.entries()) {
  const n = i + 1;
  const id = `driver-${n}`;
  const name = `Driver ${n}`;
  let note: string | undefined;
  try {
    await drivers.upsert({
      id,
      name,
      vehicle: { plate: `DEMO0${n}`, model: 'Demo sedan', category: 'STANDARD' },
      availability: 'AVAILABLE',
      position: { lat: CENTRE.lat + dLat, lng: CENTRE.lng + dLng },
    });
  } catch (err) {
    if (!(err instanceof DomainError && err.code === 'DRIVER_ON_TRIP')) throw err;
    note = 'on a trip, left unchanged';
  }
  tokens.push({ id, role: 'driver', name, token: await signToken({ id, role: 'driver' }, secret), ...(note ? { note } : {}) });
}

const passengerId = 'passenger-1';
tokens.unshift({ id: passengerId, role: 'passenger', name: 'Passenger 1', token: await signToken({ id: passengerId, role: 'passenger' }, secret) });

console.log(`Seeded table ${table}: ${OFFSETS.length} drivers around Popayán (${CENTRE.lat}, ${CENTRE.lng}).`);
console.log('Dev tokens (non-secret, signed with RIDECORE_JWT_SECRET, valid 24 h):');
for (const t of tokens) console.log(`  ${t.role.padEnd(9)} ${t.id.padEnd(12)} ${t.name.padEnd(12)} ${t.token}${t.note ? `  (${t.note})` : ''}`);
