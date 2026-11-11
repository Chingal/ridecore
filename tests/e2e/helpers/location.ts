import type { LatLng } from '../../../src/domain/trip.ts';

/**
 * On the Go path (RIDECORE_LOCATION_URL set, `make up LOCATION=1`) the deployed dispatch finds drivers
 * through ridecore-location, so a test driver must also send its position there, as a real driver
 * app does in that mode. Off: does nothing. On: opens the driver socket, keeps sending `point` every
 * 1.1 s, waits until the nearby query returns the driver, and returns a function that stops it.
 */
export async function reportToLocation(driverId: string, token: string, point: LatLng): Promise<() => void> {
  const url = process.env.RIDECORE_LOCATION_URL?.trim().replace(/\/+$/, '') ?? '';
  if (url === '') return () => undefined;
  const wsBase = (process.env.RIDECORE_LOCATION_WS_URL ?? '').replace(/\/+$/, '');
  const key = process.env.RIDECORE_LOCATION_KEY ?? '';

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`${wsBase}/v1/drivers/ws`, ['ridecore.v1', token]);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('ridecore-location refused the driver socket'));
  });
  const send = () => ws.send(JSON.stringify({ action: 'position', ...point }));
  send();
  const timer = setInterval(send, 1100);
  const stop = () => {
    clearInterval(timer);
    ws.close();
  };

  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await fetch(`${url}/v1/nearby?lat=${point.lat}&lng=${point.lng}&limit=50`, { headers: { authorization: `Bearer ${key}` } });
    const body = (await res.json()) as { drivers?: { driverId: string }[] };
    if (body.drivers?.some((d) => d.driverId === driverId)) return stop;
    if (Date.now() > deadline) {
      stop();
      throw new Error(`ridecore-location never listed ${driverId} as nearby`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
