import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

/**
 * The ridecore-location side of the local stack (docs/load-testing.md, "Go path").
 *
 *   node --import ./scripts/load-env.ts scripts/location.ts env     # add missing variables to .env.local
 *   node --import ./scripts/load-env.ts scripts/location.ts start   # Redis + Kafka + the Go service
 *   node --import ./scripts/load-env.ts scripts/location.ts stop
 *
 * The Go repository lives next to this one (LOCATION_DIR, default ../ridecore-location). The service
 * runs as a built binary in the background (pid in .load/location.pid, log in .load/location.log).
 */

export const NOT_REACHABLE = "ridecore-location is not reachable: run 'make up LOCATION=1'";

/** Dev-only defaults written to .env.local when absent (the key matches ridecore-location's .env.example). */
export const LOCATION_DEFAULTS: Record<string, string> = {
  RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090',
  RIDECORE_LOCATION_LAMBDA_URL: 'http://host.docker.internal:8090',
  RIDECORE_LOCATION_WS_URL: 'ws://127.0.0.1:8090',
  RIDECORE_LOCATION_KEY: 'dev-only-location-internal-key-change-me',
};

const PID_FILE = '.load/location.pid';
const LOG_FILE = '.load/location.log';

/**
 * Appends to `file` every location variable it does not define yet, and returns their names. Values
 * already there are the owner's and are never changed.
 */
export function ensureLocationEnv(file: string): string[] {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const defined = new Set(
    text
      .split('\n')
      .map((line) => /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  const missing = Object.keys(LOCATION_DEFAULTS).filter((name) => !defined.has(name));
  if (missing.length === 0) return [];
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n';
  const block = missing.map((name) => `${name}=${LOCATION_DEFAULTS[name]}`).join('\n');
  writeFileSync(file, `${text}${prefix}# ridecore-location (added by 'make up LOCATION=1')\n${block}\n`);
  return missing;
}

/**
 * Before a load run on the Go path: null when the path is off or the service answers /healthz with
 * 200 within 5 s, otherwise the message to print.
 */
export async function locationPreflight(env: NodeJS.ProcessEnv, doFetch: typeof fetch = fetch): Promise<string | null> {
  if (env.LOCATION !== '1') return null;
  const url = env.RIDECORE_LOCATION_URL?.trim().replace(/\/+$/, '');
  if (!url) return NOT_REACHABLE;
  try {
    const res = await doFetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
    return res.status === 200 ? null : NOT_REACHABLE;
  } catch {
    return NOT_REACHABLE;
  }
}

function docker0(): string | undefined {
  return networkInterfaces().docker0?.find((a) => a.family === 'IPv4')?.address;
}

function running(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function start(): Promise<void> {
  const dir = resolve(process.env.LOCATION_DIR ?? '../ridecore-location');
  if (!existsSync(`${dir}/go.mod`)) throw new Error(`ridecore-location not found at ${dir} (set LOCATION_DIR)`);
  const env = process.env;
  for (const name of ['RIDECORE_JWT_SECRET', 'RIDECORE_LOCATION_KEY', 'RIDECORE_LOCATION_TRIPS_QUEUE_URL']) {
    if (!env[name]) throw new Error(`${name} is not set: run 'make up LOCATION=1' (it deploys the stack first)`);
  }
  const must = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  };
  must('docker', ['compose', 'up', '-d', '--wait', 'redis', 'kafka']);
  must('go', ['build', '-trimpath', '-o', 'bin/location', './cmd/location']);

  const old = running();
  if (old !== null) {
    process.kill(old, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
  }
  mkdirSync('.load', { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const bridge = docker0();
  const child = spawn(`${dir}/bin/location`, [], {
    cwd: dir,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      LOCATION_ADDRS: ['127.0.0.1:8090', ...(bridge ? [`${bridge}:8090`] : [])].join(','),
      REDIS_ADDR: '127.0.0.1:6379',
      KAFKA_BROKERS: '127.0.0.1:9092',
      RIDECORE_JWT_SECRET: env.RIDECORE_JWT_SECRET,
      LOCATION_INTERNAL_KEY: env.RIDECORE_LOCATION_KEY,
      LOCATION_TRIPS_QUEUE_URL: env.RIDECORE_LOCATION_TRIPS_QUEUE_URL,
      AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL ?? 'http://localhost:4567',
      AWS_REGION: env.AWS_REGION ?? 'us-east-1',
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID ?? 'test',
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  closeSync(log);
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  const url = env.RIDECORE_LOCATION_URL ?? LOCATION_DEFAULTS.RIDECORE_LOCATION_URL;
  for (let i = 0; i < 60; i++) {
    if ((await locationPreflight({ LOCATION: '1', RIDECORE_LOCATION_URL: url })) === null) {
      console.log(`ridecore-location: up on ${url} (and ${bridge ?? 'no docker0'}:8090 for Floci's Lambdas); log in ${LOG_FILE}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`ridecore-location did not become healthy in 30 s; see ${LOG_FILE}`);
}

function stop(): void {
  const pid = running();
  if (pid === null) {
    console.log('ridecore-location: not running');
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`ridecore-location: stopped (pid ${pid})`);
}

if (process.argv[1]?.endsWith('location.ts')) {
  const command = process.argv[2];
  try {
    if (command === 'env') {
      const added = ensureLocationEnv('.env.local');
      console.log(added.length > 0 ? `.env.local: added ${added.join(', ')}` : '.env.local: location variables already set');
    } else if (command === 'start') await start();
    else if (command === 'stop') stop();
    else throw new Error('usage: scripts/location.ts env|start|stop');
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
