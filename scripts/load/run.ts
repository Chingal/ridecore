import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { createDynamoClient } from '../../src/infra/dynamo/client.ts';

/**
 * `make load PROFILE=...` (docs/load-testing.md): setup -> DLQ baseline -> k6 -> invariant check,
 * and teardown always, even when a step fails. Exits with the first failure. If Floci itself stops
 * answering, it says so: that is the laptop's limit, not a ridecore result.
 */
const K6_IMAGE = 'grafana/k6:2.3.0';
const profileName = process.argv[2] ?? 'smoke';
const profiles = JSON.parse(readFileSync('load/profiles.json', 'utf8')) as Record<string, { drivers: number; passengers: number }>;
const profile = profiles[profileName];
if (profile === undefined) {
  console.error(`Unknown PROFILE=${profileName} (${Object.keys(profiles).join(', ')})`);
  process.exit(1);
}
for (const name of ['RIDECORE_TABLE', 'RIDECORE_API_URL', 'RIDECORE_WS_URL']) {
  if (!process.env[name]) {
    console.error(`${name} is not set: run 'make up' first`);
    process.exit(1);
  }
}

const node = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', './scripts/load-env.ts', script, ...args], { stdio: 'inherit' }).status ?? 1;

async function flociAnswers(): Promise<boolean> {
  try {
    await createDynamoClient().send(new DescribeTableCommand({ TableName: process.env.RIDECORE_TABLE }), { abortSignal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

let status = 0;
const step = (name: string, code: number) => {
  if (code !== 0 && status === 0) {
    status = code;
    console.error(`load: ${name} failed (exit ${code})`);
  }
  return code === 0;
};

try {
  if (step('setup', node('scripts/load/actors.ts', 'setup', String(profile.drivers), String(profile.passengers))) && step('baseline', node('scripts/load/check.ts', 'baseline'))) {
    const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const k6 = spawnSync(
      'docker',
      ['run', '--rm', '--user', uid, '--network', 'host', '-v', `${process.cwd()}/load:/load:ro`, '-v', `${process.cwd()}/.load:/data`,
        K6_IMAGE, 'run', '--quiet', '-e', `API=${process.env.RIDECORE_API_URL}`, '-e', `WS=${process.env.RIDECORE_WS_URL}`, '-e', `PROFILE=${profileName}`, '/load/rush-hour.js'],
      { stdio: 'inherit' },
    );
    if (step('k6', k6.status ?? 1)) step('invariant check', node('scripts/load/check.ts'));
    else if (!(await flociAnswers())) console.error('load: Floci is not answering. This is the laptop/emulator limit, not a ridecore result.');
  }
} finally {
  if (!(await flociAnswers())) console.error('load: Floci is not answering; teardown will likely fail. Run `make load-teardown` once it is back.');
  step('teardown', node('scripts/load/actors.ts', 'teardown'));
}
process.exit(status);
