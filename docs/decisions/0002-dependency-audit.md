# ADR 0002: Dependency audit disposition

Date: 2026-11-09. Status: accepted.

## Context

`npm audit` on `feat/core` (lockfile as of this date) reports:

| Scope | Result |
|---|---|
| Production (`npm audit --omit=dev`) | **0 vulnerabilities** |
| All dependencies (`npm audit`) | 11 moderate, 0 high, 0 critical |

All 11 moderate findings are one advisory, [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (minimatch: denial of service via globparts amplification), reached only through dev tooling:

- `eslint` -> `@eslint/config-array` -> `minimatch` (also `@eslint/js`)
- `typescript-eslint` -> `@typescript-eslint/{eslint-plugin,parser,type-utils,typescript-estree,utils}` -> `minimatch`
- `aws-cdk-lib` -> `minimatch` (bundled)

The fix npm proposes is a semver-major **downgrade** of each tool (`eslint@9.39.5`, `typescript-eslint@8.36.0`, `aws-cdk-lib@2.239.0`).

## Decision

Accept the 11 moderate dev-only findings and keep the current tool versions.

- None of these packages ships in the Lambda bundle (`dist/lambda.mjs` bundles `src/` and the production dependencies; the AWS SDK comes from the runtime), so the deployed code is not exposed.
- The vulnerable path needs attacker-controlled glob patterns. Lint and CDK synth only read globs from this repository's own config, on developer machines and CI.
- Downgrading the linter and CDK to older majors trades a theoretical local DoS for losing current fixes and features.

## Enforcement

CI (`checks` job) runs two audit gates:

- `npm audit --omit=dev --audit-level=moderate`: any moderate-or-worse finding in production dependencies fails the build.
- `npm audit --audit-level=high`: any high or critical finding anywhere, dev tooling included, fails the build.

Revisit when the upstream tools release versions with a patched `minimatch`; then remove this exception.
