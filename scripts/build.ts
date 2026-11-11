import { rmSync } from 'node:fs';
import { build } from 'esbuild';

// Start from an empty dist/ so a removed entry never ships as a stale bundle.
rmSync('dist', { recursive: true, force: true });

/**
 * Bundles each Lambda entry (the API, the outbox publisher, the SQS consumers, the WebSocket routes and
 * the positions stream handler) into one ESM
 * file per function in `dist/`, for the `nodejs24.x` runtime.
 * The AWS SDK v3 stays external: the Lambda runtime ships it (checked on Floci's
 * `public.ecr.aws/lambda/nodejs:24` image, ADR 0001 and ADR 0004 probe (g)).
 * The banner gives bundled CommonJS dependencies a `require` for Node built-ins.
 */
await build({
  entryPoints: {
    lambda: 'src/http/lambda.ts',
    publisher: 'src/events/publisher.ts',
    dispatch: 'src/events/consumers/dispatch.ts',
    'driver-offers': 'src/events/consumers/driver-offers.ts',
    billing: 'src/events/consumers/billing.ts',
    notifier: 'src/events/consumers/notifier.ts',
    ws: 'src/realtime/ws.ts',
    positions: 'src/realtime/positions.ts',
  },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@aws-sdk/*'],
  sourcemap: false,
  legalComments: 'none',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
