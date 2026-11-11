// A rush hour against the local stack (docs/load-testing.md). Run through `make load PROFILE=...`:
//   drivers  - one WebSocket each, a position every 3 s; accept an offer push, then arrive/start/complete
//   watchers - one WebSocket each, `watch` at their position, count map messages
//   riders   - HTTP only: request a trip, wait for a driver, sometimes cancel, otherwise ride and rate
// Actors and tokens come from /data/actors.json (written by scripts/load/actors.ts, git-ignored).
import exec from 'k6/execution';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { WebSocket } from 'k6/websockets';
import { call, destinationFrom, metrics, randomKey, step, WS } from './lib.js';

const PROFILE_NAME = __ENV.PROFILE || 'smoke';
const PROFILE = JSON.parse(open('./profiles.json'))[PROFILE_NAME];
if (!PROFILE) throw new Error(`Unknown PROFILE ${PROFILE_NAME}`);
const ACTORS = new SharedArray('actors', () => {
  const a = JSON.parse(open('/data/actors.json'));
  return [a];
})[0];
const LOAD_CENTRE = { lat: 2.45, lng: -76.47 };
const CONFLICT_CODES = ['TRIP_ALREADY_TAKEN', 'CONCURRENT_UPDATE', 'ACTIVE_TRIP_EXISTS', 'INVALID_TRANSITION', 'DRIVER_BUSY', 'REQUEST_IN_PROGRESS'];

const D = PROFILE.durationSeconds;
const WATCHERS = PROFILE.watchers;
const RIDERS = PROFILE.passengers - WATCHERS;
const scenario = (fn, vus) => ({ executor: 'per-vu-iterations', exec: fn, vus, iterations: 1, maxDuration: `${D + 90}s` });

export const options = {
  scenarios: Object.assign(
    { drivers: scenario('drivers', PROFILE.drivers) },
    WATCHERS > 0 ? { watchers: scenario('watchers', WATCHERS) } : {},
    RIDERS > 0 ? { riders: scenario('riders', RIDERS) } : {},
  ),
  thresholds: Object.assign(
    // Always-true thresholds on tagged sub-metrics, so the summary splits the 409s by code.
    Object.fromEntries(CONFLICT_CODES.map((code) => [`conflicts_409{code:${code}}`, ['count>=0']])),
    PROFILE.thresholds
      ? {
          http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
          ws_refused: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '30s' }],
        }
      : {},
  ),
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'count'],
};

/** Seconds to wait before this actor starts: spread over the ramp, or, for a spike, most riders late. */
function startDelay(index, count, isRider) {
  if (isRider && PROFILE.spikeAtSeconds !== null) {
    const base = Math.max(1, Math.round(count / 10));
    return index < base ? Math.random() * 10 : PROFILE.spikeAtSeconds + ((index - base) / Math.max(1, count - base)) * 20;
  }
  return (index / Math.max(1, count)) * PROFILE.rampSeconds;
}

/** Opens a socket with the ridecore subprotocol; records whether it was refused. */
function openSocket(token, onOpen, onMessage, liveMs) {
  let opened = false;
  const ws = new WebSocket(WS, ['ridecore.v1', token]);
  ws.onopen = () => {
    opened = true;
    metrics.wsRefused.add(false);
    onOpen(ws);
    setTimeout(() => ws.close(), liveMs);
  };
  ws.onmessage = (m) => onMessage(ws, JSON.parse(m.data));
  ws.onerror = () => {
    if (!opened) metrics.wsRefused.add(true);
  };
  return ws;
}

export function drivers() {
  const index = exec.scenario.iterationInTest;
  const me = ACTORS.drivers[index];
  const delay = startDelay(index, PROFILE.drivers, false);
  sleep(delay);
  let pos = me.position;
  let busy = false;

  const drive = (tripId) => {
    const steps = ['arrive', 'start', 'complete'];
    let i = 0;
    const next = () => {
      const action = steps[i++];
      const res = call(me.token, 'POST', `/trips/${tripId}/${action}`);
      if (res.status !== 200 || i === steps.length) {
        if (res.status === 200) metrics.tripsCompleted.add(1);
        busy = false;
        return;
      }
      setTimeout(next, 2000 + Math.random() * 3000);
    };
    setTimeout(next, 2000 + Math.random() * 3000);
  };

  openSocket(
    me.token,
    (ws) => {
      const timer = setInterval(() => {
        pos = step(pos);
        ws.send(JSON.stringify({ action: 'position', lat: pos.lat, lng: pos.lng }));
      }, 3000);
      setTimeout(() => clearInterval(timer), (D - delay) * 1000);
    },
    (_ws, msg) => {
      if (msg.type !== 'offer' || busy) return;
      metrics.offerPush.add(Date.now() - Date.parse(msg.offer.offeredAt));
      busy = true;
      const res = call(me.token, 'POST', `/trips/${msg.offer.tripId}/accept`);
      if (res.status === 200) drive(msg.offer.tripId);
      else busy = false;
    },
    (D - delay) * 1000,
  );
}

export function watchers() {
  const index = exec.scenario.iterationInTest;
  const me = ACTORS.passengers[index];
  const delay = startDelay(index, WATCHERS, false);
  sleep(delay);
  // The crowded profile puts every watcher in one cell on purpose (Review Focus 4).
  const at = PROFILE_NAME === 'crowded' ? LOAD_CENTRE : me.position;
  openSocket(
    me.token,
    (ws) => ws.send(JSON.stringify({ action: 'watch', lat: at.lat, lng: at.lng })),
    (_ws, msg) => {
      if (msg.type === 'car' || msg.type === 'car.left') metrics.mapMessages.add(1);
    },
    (D - delay) * 1000,
  );
}

const TERMINAL = ['COMPLETED', 'RATED', 'CANCELLED'];

export function riders() {
  const index = exec.scenario.iterationInTest;
  const me = ACTORS.passengers[WATCHERS + index];
  const delay = startDelay(index, RIDERS, true);
  sleep(delay);
  const end = Date.now() + (D - delay) * 1000;
  const stateOf = (id, fallback) => call(me.token, 'GET', `/trips/${id}`).body.state || fallback;

  while (Date.now() < end) {
    const created = call(me.token, 'POST', '/trips', { origin: me.position, destination: destinationFrom(me.position) }, { 'idempotency-key': randomKey() });
    if (created.status !== 201) {
      sleep(5);
      continue;
    }
    const id = created.body.id;
    const t0 = Date.now();
    let state = 'REQUESTED';
    while (state === 'REQUESTED' && Date.now() - t0 < 60000) {
      sleep(2);
      state = stateOf(id, state);
    }
    if (state === 'REQUESTED') {
      metrics.tripsUnaccepted.add(1);
      call(me.token, 'POST', `/trips/${id}/cancel`, { reason: 'no driver' });
    } else if (!TERMINAL.includes(state)) {
      metrics.timeToAccept.add(Date.now() - t0);
      if (Math.random() < 0.2 && (state === 'ACCEPTED' || state === 'DRIVER_ARRIVED')) {
        call(me.token, 'POST', `/trips/${id}/cancel`, { reason: 'changed plans' });
      } else {
        const t1 = Date.now();
        while (!TERMINAL.includes(state) && Date.now() - t1 < 60000) {
          sleep(2);
          state = stateOf(id, state);
        }
        if (state === 'COMPLETED') call(me.token, 'POST', `/trips/${id}/rating`, { score: 5 });
      }
    }
    sleep(5 + Math.random() * 10);
  }
}

function metricLine(data, name, unit) {
  const m = data.metrics[name];
  if (!m) return `  ${name}: no samples`;
  const v = m.values;
  if (m.type === 'trend') return `  ${name}: p50 ${v['p(50)'].toFixed(0)}${unit} p95 ${v['p(95)'].toFixed(0)}${unit} p99 ${v['p(99)'].toFixed(0)}${unit} max ${v.max.toFixed(0)}${unit} (n=${v.count})`;
  if (m.type === 'rate') return `  ${name}: ${(v.rate * 100).toFixed(2)}%`;
  return `  ${name}: ${v.count}`;
}

export function handleSummary(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const lines = [
    `ridecore load, profile ${PROFILE_NAME} (Floci on a laptop: behaviour under concurrency, not AWS capacity)`,
    metricLine(data, 'http_reqs', ''),
    metricLine(data, 'http_req_failed', ''),
    metricLine(data, 'http_req_duration', 'ms'),
    metricLine(data, 'offer_push_ms', 'ms'),
    metricLine(data, 'time_to_accept_ms', 'ms'),
    metricLine(data, 'trips_completed', ''),
    metricLine(data, 'trips_unaccepted', ''),
    metricLine(data, 'conflicts_409', ''),
    ...CONFLICT_CODES.filter((c) => data.metrics[`conflicts_409{code:${c}}`]?.values.count > 0).map((c) => `    ${c}: ${data.metrics[`conflicts_409{code:${c}}`].values.count}`),
    metricLine(data, 'app_errors', ''),
    metricLine(data, 'map_messages', ''),
    metricLine(data, 'ws_refused', ''),
  ];
  return { stdout: `${lines.join('\n')}\n`, [`/data/summary-${PROFILE_NAME}-${stamp}.json`]: JSON.stringify(data, null, 2) };
}
