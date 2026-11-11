import type { LatLng } from '../src/domain/trip.ts';
import { signToken } from '../src/http/auth.ts';
import { DEMO_DRIVERS } from './demo-drivers.ts';

/**
 * Drives the seeded cars around small loops over their own sockets, so the demo map has something
 * to show (ADR 0005). Each driver sends a `position` every 2 s.
 *
 *   node --import ./scripts/load-env.ts scripts/move-drivers.ts [--seconds 120]   # or: make demo-map
 */
const RADIUS_M = 150;
const STEPS = 36;
const METRES_PER_DEGREE = 111_320;

/** Step `k` of a circular loop of RADIUS_M that starts and ends at `start` (STEPS steps per lap). */
export function loopPoint(start: LatLng, k: number): LatLng {
  const theta = (2 * Math.PI * (k % STEPS)) / STEPS;
  const north = RADIUS_M * (1 - Math.cos(theta));
  const east = RADIUS_M * Math.sin(theta);
  return {
    lat: start.lat + north / METRES_PER_DEGREE,
    lng: start.lng + east / (METRES_PER_DEGREE * Math.cos((start.lat * Math.PI) / 180)),
  };
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['ridecore.v1', token]);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('socket refused (is the stack up? run make up)'));
  });
}

if (import.meta.main) {
  const url = process.env.RIDECORE_WS_URL;
  const secret = process.env.RIDECORE_JWT_SECRET;
  if (!url || !secret) {
    console.error("RIDECORE_WS_URL and RIDECORE_JWT_SECRET must be set (run 'make up')");
    process.exit(1);
  }
  const at = process.argv.indexOf('--seconds');
  const seconds = at === -1 ? 120 : Number(process.argv[at + 1]);
  const sockets = await Promise.all(DEMO_DRIVERS.map(async (d) => ({ d, ws: await open(url, await signToken({ id: d.id, role: 'driver' }, secret)) })));
  console.log(`Moving ${sockets.length} drivers for ${seconds} s (a position every 2 s each). Ctrl+C to stop.`);
  let k = 0;
  const timer = setInterval(() => {
    k++;
    for (const { d, ws } of sockets) ws.send(JSON.stringify({ action: 'position', ...loopPoint(d.position, k + d.n * 6) }));
  }, 2000);
  setTimeout(() => {
    clearInterval(timer);
    for (const { ws } of sockets) ws.close();
  }, seconds * 1000);
}
