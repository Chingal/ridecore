import { build } from 'esbuild';

/**
 * Bundles the API Lambda (`src/http/handler.ts`) into one ESM file for the `nodejs24.x` runtime.
 * The AWS SDK v3 stays external: the Lambda runtime ships it (checked on Floci's
 * `public.ecr.aws/lambda/nodejs:24` image, which has `@aws-sdk/client-dynamodb` and `lib-dynamodb`).
 * The banner gives bundled CommonJS dependencies a `require` for Node built-ins.
 */
await build({
  entryPoints: ['src/http/handler.ts'],
  outfile: 'dist/handler.mjs',
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
