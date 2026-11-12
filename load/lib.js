// Helpers shared by the k6 scenarios (docs/load-testing.md). Plain k6 JavaScript, no remote imports.
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

export const API = (__ENV.API || '').replace(/\/+$/, '');
export const WS = __ENV.WS || '';
// Set on the Go path (make load LOCATION=1): ridecore-location's WebSocket base, e.g. ws://127.0.0.1:8090.
export const LOC_WS = (__ENV.LOC_WS || '').replace(/\/+$/, '');

export const metrics = {
  conflicts: new Counter('conflicts_409'),
  wsRefused: new Rate('ws_refused'),
  mapMessages: new Counter('map_messages'),
  offerPush: new Trend('offer_push_ms', true),
  timeToAccept: new Trend('time_to_accept_ms', true),
  tripsCompleted: new Counter('trips_completed'),
  tripsUnaccepted: new Counter('trips_unaccepted'),
  appErrors: new Counter('app_errors'),
};

// 409s are expected under load (two drivers accepting, one active trip per passenger): not failures.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

export function randomKey() {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** One API call. Returns { status, body }; counts 409s by code and any other 4xx/5xx. */
export function call(token, method, path, body, extraHeaders) {
  const headers = Object.assign({ authorization: `Bearer ${token}` }, extraHeaders || {});
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = http.request(method, `${API}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers,
    timeout: '10s',
    tags: { route: path.replace(/[0-9a-f-]{36}/g, '{id}') },
  });
  let parsed;
  try {
    parsed = res.body ? JSON.parse(res.body) : {};
  } catch {
    parsed = {};
  }
  if (res.status === 409) metrics.conflicts.add(1, { code: (parsed.error && parsed.error.code) || 'UNKNOWN' });
  else if (res.status >= 400 || res.status === 0) metrics.appErrors.add(1, { status: String(res.status) });
  return { status: res.status, body: parsed };
}

/** A small random step, about 10-30 m, so cars move without leaving their area. */
export function step(p) {
  return { lat: p.lat + (Math.random() - 0.5) * 0.0004, lng: p.lng + (Math.random() - 0.5) * 0.0004 };
}

/** A destination 1-3 km away. */
export function destinationFrom(p) {
  const angle = Math.random() * 2 * Math.PI;
  const km = 1 + Math.random() * 2;
  return { lat: p.lat + (km * Math.cos(angle)) / 111.32, lng: p.lng + (km * Math.sin(angle)) / 111.32 };
}
