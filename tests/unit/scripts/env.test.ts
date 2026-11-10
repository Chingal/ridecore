import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, toShellExports } from '../../../scripts/env.ts';

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ridecore-env-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('env policy: exported > .env.local > .env.deploy > .env.example', () => {
  it('fills only unset names, .env.local before .env.example', () => {
    const dir = root({
      '.env.example': 'A=example\nB=example\nC=example\n',
      '.env.local': "B=local\nC=local\nURL='http://h/_aws/x/$default'\n",
    });
    const env: NodeJS.ProcessEnv = { C: 'exported' };
    const names = loadEnv(env, dir);
    expect(env).toEqual({ A: 'example', B: 'local', C: 'exported', URL: 'http://h/_aws/x/$default' });
    expect(names.sort()).toEqual(['A', 'B', 'C', 'URL']);
  });

  it('.env.local (user settings) wins over the generated .env.deploy, which wins over .env.example', () => {
    const dir = root({
      '.env.example': 'RIDECORE_JWT_SECRET=example-secret\nRIDECORE_TABLE=ridecore\nX=example\n',
      '.env.deploy': "RIDECORE_TABLE=generated-table\nRIDECORE_API_URL='http://h/$default'\nRIDECORE_JWT_SECRET=nope\n",
      '.env.local': 'RIDECORE_JWT_SECRET=my-own-secret-that-is-long-enough-123\n',
    });
    const env: NodeJS.ProcessEnv = {};
    loadEnv(env, dir);
    expect(env).toEqual({
      RIDECORE_JWT_SECRET: 'my-own-secret-that-is-long-enough-123',
      RIDECORE_TABLE: 'generated-table',
      RIDECORE_API_URL: 'http://h/$default',
      X: 'example',
    });
  });

  it('works without .env.local', () => {
    const env: NodeJS.ProcessEnv = {};
    loadEnv(env, root({ '.env.example': 'A=1\n' }));
    expect(env).toEqual({ A: '1' });
  });

  it('prints shell exports that keep $ and quotes literal and do not overwrite exported values', () => {
    const env: NodeJS.ProcessEnv = { A: "it's $HOME", B: 'x' };
    const script = `${toShellExports(['A', 'B', 'MISSING'], env)}\nprintf '%s|%s' "$A" "$B"`;
    expect(execFileSync('sh', ['-c', script], { encoding: 'utf8' })).toBe("it's $HOME|x");
  });
});
