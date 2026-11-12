import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployedPathMismatch, ensureLocationEnv, isOurProcess, lambdaLocationUrl, locationPreflight, readPid } from '../../../scripts/location.ts';

const NOT_REACHABLE = "ridecore-location is not reachable: run 'make up LOCATION=1'";

describe('locationPreflight', () => {
  it('is skipped when the location path is off', async () => {
    let called = false;
    const fetchStub = (async () => ((called = true), new Response('{}'))) as unknown as typeof fetch;
    await expect(locationPreflight({}, fetchStub)).resolves.toBeNull();
    expect(called).toBe(false);
  });

  // Review Focus 5: stop before creating actors when the Go service is down.
  it.each([
    ['refused', () => Promise.reject(new TypeError('fetch failed'))],
    ['503', () => Promise.resolve(new Response('{"status":"degraded"}', { status: 503 }))],
  ])('fails when /healthz is %s', async (_name, respond) => {
    const fetchStub = (async () => respond()) as unknown as typeof fetch;
    await expect(locationPreflight({ LOCATION: '1', RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090' }, fetchStub)).resolves.toBe(NOT_REACHABLE);
  });

  it('fails when the URL is missing', async () => {
    await expect(locationPreflight({ LOCATION: '1' }, fetch)).resolves.toBe(NOT_REACHABLE);
  });

  it('passes when /healthz answers 200', async () => {
    const urls: string[] = [];
    const fetchStub = (async (u: string) => (urls.push(u), new Response('{"status":"ok"}'))) as unknown as typeof fetch;
    await expect(locationPreflight({ LOCATION: '1', RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090/' }, fetchStub)).resolves.toBeNull();
    expect(urls).toEqual(['http://127.0.0.1:8090/healthz']);
  });
});

describe('ensureLocationEnv', () => {
  it('adds the missing location variables and never overwrites the owner values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ridecore-env-'));
    const file = join(dir, '.env.local');
    writeFileSync(file, 'RIDECORE_JWT_SECRET=mine-mine-mine-mine-mine-mine-mine\nRIDECORE_LOCATION_KEY=my-own-key-of-at-least-32-characters!!\n');
    const added = ensureLocationEnv(file);
    expect(added).toEqual(['RIDECORE_LOCATION_URL', 'RIDECORE_LOCATION_LAMBDA_URL', 'RIDECORE_LOCATION_WS_URL']);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('RIDECORE_LOCATION_KEY=my-own-key-of-at-least-32-characters!!');
    expect(text).toContain('RIDECORE_JWT_SECRET=mine-mine-mine-mine-mine-mine-mine');
    expect(text).toContain('RIDECORE_LOCATION_URL=http://127.0.0.1:8090');
    expect(text).toContain('RIDECORE_LOCATION_LAMBDA_URL=http://host.docker.internal:8090');
    expect(text).toContain('RIDECORE_LOCATION_WS_URL=ws://127.0.0.1:8090');
    expect(ensureLocationEnv(file)).toEqual([]); // idempotent
  });

  it('creates the file when it does not exist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ridecore-env-')), '.env.local');
    expect(ensureLocationEnv(file)).toHaveLength(4);
    expect(readFileSync(file, 'utf8')).toContain('RIDECORE_LOCATION_KEY=dev-only-location-internal-key-change-me');
  });
});

describe('lambdaLocationUrl (one switch: RIDECORE_LOCATION_URL)', () => {
  it.each([
    [{}, ''],
    [{ RIDECORE_LOCATION_URL: '' }, ''],
    [{ RIDECORE_LOCATION_URL: '', RIDECORE_LOCATION_LAMBDA_URL: 'http://host.docker.internal:8090' }, ''],
    [{ RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090' }, 'http://host.docker.internal:8090'],
    [{ RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090', RIDECORE_LOCATION_LAMBDA_URL: 'http://10.0.0.5:8090' }, 'http://10.0.0.5:8090'],
  ])('%j → %j', (env, want) => {
    expect(lambdaLocationUrl(env)).toBe(want);
  });
});

describe('readPid and isOurProcess', () => {
  it.each(['', '0', '-5', 'abc', '12x', '1.5'])('rejects %j', (text) => {
    expect(readPid(text)).toBeNull();
  });

  it('reads a positive integer', () => {
    expect(readPid(' 4242\n')).toBe(4242);
  });

  it('does not take another process for the service', () => {
    expect(isOurProcess(process.pid, '/nonexistent/ridecore-location/bin/location')).toBe(false);
  });
});

describe('ensureLocationEnv reads the file like the env loader', () => {
  it('recognises export lines and quoted values, and adds nothing over them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ridecore-env-')), '.env.local');
    writeFileSync(
      file,
      [
        'export RIDECORE_LOCATION_KEY=my-own-key-of-at-least-32-characters!!',
        'RIDECORE_LOCATION_URL="http://127.0.0.1:9999"',
        "RIDECORE_LOCATION_LAMBDA_URL='http://10.0.0.5:9999'",
        'RIDECORE_LOCATION_WS_URL=ws://127.0.0.1:9999',
        '',
      ].join('\n'),
    );
    expect(ensureLocationEnv(file)).toEqual([]);
    expect(readFileSync(file, 'utf8')).not.toContain('dev-only-location-internal-key-change-me');
  });
});

describe('deployedPathMismatch', () => {
  it('is null when the deployed dispatch matches the requested path', () => {
    expect(deployedPathMismatch(true, 'http://host.docker.internal:8090')).toBeNull();
    expect(deployedPathMismatch(false, '')).toBeNull();
    expect(deployedPathMismatch(false, undefined)).toBeNull();
  });

  it('explains a mismatch in both directions', () => {
    expect(deployedPathMismatch(true, '')).toMatch(/deployed dispatch reads the DynamoDB index/);
    expect(deployedPathMismatch(false, 'http://host.docker.internal:8090')).toMatch(/deployed dispatch uses ridecore-location/);
  });
});

describe('isOurProcess after a rebuild', () => {
  const binary = '/home/x/ridecore-location/bin/location';
  // `go build` replaces the file, so Linux shows the running process's exe as "<path> (deleted)".
  it('still recognises the service when its binary was rebuilt', () => {
    expect(isOurProcess(42, binary, () => `${binary} (deleted)`)).toBe(true);
  });
  it('rejects any other executable', () => {
    expect(isOurProcess(42, binary, () => '/usr/bin/zsh')).toBe(false);
    expect(isOurProcess(42, binary, () => `${binary}-other (deleted)`)).toBe(false);
  });
});
