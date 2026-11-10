import { fileURLToPath } from 'node:url';
import { loadEnv, toShellExports } from './env.ts';

/**
 * Applies the env policy of `scripts/env.ts` (exported env > .env.local > .env.deploy > .env.example) on import.
 *   node --import ./scripts/load-env.ts <script>   preload, before the script's own imports run
 *   eval "$(node scripts/load-env.ts --print)"      export the resolved values into a shell
 *   Vitest `setupFiles` (e2e project)               same effect for the e2e tests
 */
const names = loadEnv();
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--print')) {
  console.log(toShellExports(names));
}
