# ADR 0001: Toolchain compatibility spike

Date: 2026-11-09. Status: accepted. Answers spec section 8, checks (a)-(e).

## Context

Before any product code, we verified that the planned toolchain (Node 26 dev, Lambda, Serverless Framework, CDK, Floci 2.4.0 as local AWS) works end to end. All probes ran against `floci/floci:2.4.0` through `docker-compose.yml`, with an AWS CLI v1.46.3 installed in a throwaway venv (not on the host) and dummy credentials (`test`/`test`, `us-east-1`).

Floci listens on port 4566 inside the container, so the compose mapping is `127.0.0.1:4567:4566` (not `4567:4567`). It also needs `/var/run/docker.sock` mounted to run Lambda containers. `FLOCI_STORAGE_MODE=memory` is accepted.

## Results

| Check | Result | Evidence |
|---|---|---|
| (a) Lambda `nodejs26.x` | Accepted by `create-function`, **fails at invoke** | Invoke payload: `Failed to start Lambda container: The runtime parameter nodejs26.x is not supported.` (`Lambda.InitError`) |
| (a) Lambda `nodejs24.x` | **Pass** | `aws lambda invoke` payload: `{"v":"v24.22.2"}` |
| (b) Serverless v4 (`serverless@4.46.0`) | `package` **requires login** | `npx serverless package` -> `You must sign in or use a License Key with Serverless Framework V.4 and later versions` |
| (b) OSS fork `osls@4.6.0` (MIT, `oss-serverless/osls`) | `package` and `deploy` need **no login** | `Service packaged`; `Service deployed to stack spike-sls-dev (10s)`; function `spike-sls-dev-ping` listed with runtime `nodejs24.x`; invoke returned `{"statusCode":200,"body":"{\"v\":\"v24.22.2\"}"}` |
| (c) CDK -> Floci | **Pass** with `aws-cdk@2.1148.0` + env endpoint override | `cdk bootstrap` and `cdk deploy` succeeded; `describe-table` -> `"StreamSpecification": {"StreamEnabled": true, "StreamViewType": "NEW_AND_OLD_IMAGES"}`, status `ACTIVE` |
| (d) EventBridge -> SQS | **Pass** | `put-rule` + `put-targets` (SQS ARN) + `put-events`; `receive-message` returned the event envelope (`"source":"ridecore.spike"`, `"detail":{"a":1}`) |
| (d) DynamoDB Streams -> Lambda | **Pass** | `create-event-source-mapping` (state `Enabled`), `put-item`, then log group `/aws/lambda/ddb-h` contained `STREAM_EVENT {"Records":[{"eventName":"INSERT", ... "NewImage":{"pk":{"S":"k1"}...}]}` |

Additional findings:

- Endpoint override works through environment variables only, for both osls and CDK, with no plugin or `cdklocal`: `AWS_ENDPOINT_URL=http://localhost:4567 AWS_ENDPOINT_URL_S3=http://localhost:4567 AWS_S3_FORCE_PATH_STYLE=true`.
- CDK needs `cdk bootstrap aws://000000000000/us-east-1` once per fresh Floci (memory storage, so after every restart) before `cdk deploy`.
- HTTP API invocation on Floci: `curl http://localhost:4567/_aws/execute-api/<apiId>/$default/ping` returned `{"v":"v24.22.2"}` (200). The `execute-api.amazonaws.com` URL printed by osls is not reachable locally.
- `ts-node` crashes with TypeScript 7.0.2 (`Cannot read properties of undefined (reading 'fileExists')`). CDK app ran with Node's native type stripping: `"app": "node bin/app.ts"` with `"type": "module"` in `package.json`. Use `import` statements with erasable-only TypeScript syntax (no enums, no parameter properties).
- The Floci image logs `Could not reconcile orphaned EC2 containers` at start; harmless.

## Decisions

1. **Lambda runtime: `nodejs24.x`** in all deployed definitions (Serverless and CDK). Floci cannot run `nodejs26.x`. Local development and tests still use Node 26.13.0.
2. **Serverless binary: `osls` 4.x (OSS fork)**, pinned as a dev dependency. `serverless` v4 requires login even for `package`, which we will not use. `frameworkVersion: '4'` must be omitted from `serverless.yml` (osls reports its own version).
3. **CDK deploy to Floci:** run `cdk bootstrap` then `cdk deploy` with the three env vars above; no `cdklocal` needed.
4. **EventBridge -> SQS and DynamoDB Streams -> Lambda both work** on Floci, so integration tests can exercise the real event flow.
5. **Execution path (local and CI): deploy to Floci** (`docker compose up -d floci`, bootstrap, deploy, run integration tests against `http://localhost:4567`). CI needs Docker with the socket available to the Floci container.

## Fallbacks

- If Floci regresses or a service misbehaves: keep the unit tests on local adapters (in-memory ports) and run only the affected integration test against a newer Floci tag.
- If `nodejs26.x` becomes runnable on Floci (or in AWS Lambda), switch the runtime value in one place; handlers already target Node 24 compatibility.
- If `osls` is abandoned: Serverless Framework v3 (`legacy` dist-tag of `osls`: 3.80.0) or CDK-only deploys, which already work.
- If `ts-node` stays broken: keep native type stripping for CDK apps, or compile with `tsc` and run the JS.
