# ADR 0001: Toolchain compatibility spike

Date: 2026-11-09. Status: accepted. Probe host: `node --version` = `v26.13.0` (PATH `~/.nvm/versions/node/v26.13.0/bin`). Versions: Floci 2.4.0 (native, Quarkus 3.40.1), serverless 4.46.0, osls 4.6.0, aws-cdk 2.1148.0, aws-cdk-lib 2.275.0, typescript 7.0.2, aws-cli 1.46.3. Answers spec section 8, checks (a)-(e).

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
- HTTP API invocation on Floci: `curl "http://localhost:4567/_aws/execute-api/<apiId>/\$default/ping"` returned `{"v":"v24.22.2"}` (200). The `execute-api.amazonaws.com` URL printed by osls is not reachable locally.
- `ts-node` crashes with TypeScript 7.0.2 (`Cannot read properties of undefined (reading 'fileExists')`). CDK app ran with Node's native type stripping: `"app": "node bin/app.ts"` with `"type": "module"` in `package.json`. Use `import` statements with erasable-only TypeScript syntax (no enums, no parameter properties).
- `Could not reconcile orphaned EC2 containers: java.net.SocketException` appeared only in the first start, before `/var/run/docker.sock` was mounted. With the socket mounted (final compose file) it does not appear (checked with `docker logs | grep orphan`: no match), so it does not affect the chosen path.
- Do not install `serverless` and `osls` in the same package: both provide a `serverless` bin and `npx serverless` then runs osls.

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

## Evidence (probe commands and output, re-captured 2026-11-09)

Env for every command: `export PATH=$HOME/.nvm/versions/node/v26.13.0/bin:$PATH AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1` and `aws() { <venv>/bin/aws --endpoint-url http://localhost:4567 "$@"; }`.

<details><summary>Baseline, Lambda runtimes (a)</summary>

Probe: `index.mjs` = `export const handler = async () => ({ v: process.version })`, zipped to `h.zip`; role created with `aws iam create-role --role-name r --assume-role-policy-document '{"Version":"2012-10-17","Statement":[]}'`.

```
$ node --version
v26.13.0
$ docker compose up -d floci
 Container ridecore-floci-1 Created 
 Container ridecore-floci-1 Starting 
 Container ridecore-floci-1 Started 
$ aws --endpoint-url http://localhost:4567 dynamodb list-tables
{
    "TableNames": []
}
$ aws lambda create-function --function-name h-nodejs26 --runtime nodejs26.x --handler index.handler --role arn:aws:iam::000000000000:role/r --zip-file fileb://h.zip
h-nodejs26	nodejs26.x	Active
$ aws lambda invoke --function-name h-nodejs26 out.json; cat out.json
{"errorMessage":"Failed to start Lambda container: The runtime parameter nodejs26.x is not supported.","errorType":"Lambda.InitError"}
$ aws lambda create-function --function-name h-nodejs24 --runtime nodejs24.x --handler index.handler --role arn:aws:iam::000000000000:role/r --zip-file fileb://h.zip
h-nodejs24	nodejs24.x	Active
$ aws lambda invoke --function-name h-nodejs24 out.json; cat out.json
{"v":"v24.22.2"}
```
</details>

<details><summary>Serverless v4 vs osls (b)</summary>

`serverless.yml` (osls; no `frameworkVersion`), `handler.mjs` returns `{ statusCode: 200, body: JSON.stringify({ v: process.version }) }`:

```yaml
service: spike-sls
provider:
  name: aws
  runtime: nodejs24.x
  region: us-east-1
  stage: dev
functions:
  ping:
    handler: handler.handler
    events:
      - httpApi:
          method: GET
          path: /ping
```

Serverless v4 (separate dir, only `serverless@4.46.0` installed):

```
$ npx serverless --version

Serverless ϟ Framework 4.46.0
$ npx serverless package

✖ You must sign in or use a License Key with Serverless Framework V.4 and later versions: if the user is at the keyboard, run "serverless login" (without a terminal it prints a sign-in URL for them to open and waits up to 10 minutes); for unattended runs, set SERVERLESS_ACCESS_KEY (create one at https://app.serverless.com/settings/accessKeys) or SERVERLESS_LICENSE_KEY (create one at https://app.serverless.com/settings/licenseKeys).
```

osls (dir with `osls@4.6.0`; the first line shows the bin collision when both are installed together; deploy uses `AWS_ENDPOINT_URL=http://localhost:4567 AWS_ENDPOINT_URL_S3=http://localhost:4567 AWS_S3_FORCE_PATH_STYLE=true`; the 32 MB package size is only because the probe packaged its `node_modules`):

```
$ npx serverless --version
osls version: 4.6.0
$ npx serverless package   # osls installed alongside, so this ran osls

Packaging spike-sls for stage dev (us-east-1)

✔ Service packaged (4s)
$ npx osls --version
osls version: 4.6.0
$ npx osls package
Packaging spike-sls for stage dev (us-east-1)

✔ Service packaged (4s)
$ npx osls deploy

✔ Service deployed to stack spike-sls-dev (15s)

endpoint: GET - https://6444c3ecb8.execute-api.us-east-1.amazonaws.com/ping
functions:
  ping: spike-sls-dev-ping (32 MB)
$ aws lambda invoke --function-name spike-sls-dev-ping o.json; cat o.json
{"statusCode":200,"body":"{\"v\":\"v24.22.2\"}"}
$ curl 'http://localhost:4567/_aws/execute-api/6444c3ecb8/$default/ping'
{"v":"v24.22.2"} [200]
```
</details>

<details><summary>CDK synth and deploy (c)</summary>

`cdk.json`: `{ "app": "node bin/app.ts" }`; `package.json` has `"type": "module"`. `bin/app.ts`:

```ts
import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
const app = new cdk.App();
const stack = new cdk.Stack(app, 'SpikeStack', { env: { account: '000000000000', region: 'us-east-1' } });
new ddb.Table(stack, 'T', {
  tableName: 'spike-cdk',
  partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
  billingMode: ddb.BillingMode.PAY_PER_REQUEST,
  stream: ddb.StreamViewType.NEW_AND_OLD_IMAGES,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

Synth and ts-node failure:

```
├── aws-cdk-lib@2.275.0
├── aws-cdk@2.1148.0
└── typescript@7.0.2
$ npx cdk synth | grep -B2 -A12 StreamSpecification
    Properties:
      AttributeDefinitions:
        - AttributeName: pk
          AttributeType: S
      BillingMode: PAY_PER_REQUEST
      KeySchema:
        - AttributeName: pk
          KeyType: HASH
      StreamSpecification:
        StreamViewType: NEW_AND_OLD_IMAGES
      TableName: spike-cdk
    UpdateReplacePolicy: Delete
    DeletionPolicy: Delete
    Metadata:
      aws:cdk:path: SpikeStack/T/Resource
--- ts-node failure (npx ts-node bin/app.ts)
TypeError: Cannot read properties of undefined (reading 'fileExists')
```

Bootstrap and deploy (env override as above; on a fresh Floci a deploy without bootstrap fails with `SsmParameterNotFound: /cdk-bootstrap/hnb659fds/version`):

```
$ npx cdk bootstrap aws://000000000000/us-east-1
CDKToolkit: creating CloudFormation changeset...
✅  Environment aws://000000000000/us-east-1 bootstrapped.
$ npx cdk deploy --require-approval never
SpikeStack: start: Building SpikeStack Template
SpikeStack: success: Built SpikeStack Template
SpikeStack: start: Publishing SpikeStack Template (000000000000-us-east-1-ef197e6b)
SpikeStack: success: Published SpikeStack Template (000000000000-us-east-1-ef197e6b)
SpikeStack: creating CloudFormation changeset...
SpikeStack: deploying... [1/1]
✅  SpikeStack
✨  Deployment time: 0.04s
arn:aws:cloudformation:us-east-1:000000000000:stack/SpikeStack/678fd776-f8ed-4f9e-b0cf-8f2cba9439e9
$ aws dynamodb describe-table --table-name spike-cdk --query 'Table.[TableStatus,StreamSpecification]'
[
    "ACTIVE",
    {
        "StreamEnabled": true,
        "StreamViewType": "NEW_AND_OLD_IMAGES"
    }
]
```
</details>

<details><summary>EventBridge to SQS, DynamoDB Streams to Lambda (d)</summary>

Stream handler `ddb.mjs`: `export const handler = async (e) => { console.log('STREAM_EVENT ' + JSON.stringify(e)); return {}; };` (runtime `nodejs24.x`, same role and zip method as above). Table `spike-cdk` is the one deployed by CDK.

```
# EventBridge -> SQS
$ Q=$(aws sqs create-queue --queue-name spike-q --query QueueUrl --output text); echo $Q
http://localhost:4567/000000000000/spike-q
$ aws events put-rule --name spike-rule --event-pattern '{"source":["ridecore.spike"]}' --query RuleArn --output text
arn:aws:events:us-east-1:000000000000:rule/spike-rule
$ aws events put-targets --rule spike-rule --targets 'Id=1,Arn=arn:aws:sqs:us-east-1:000000000000:spike-q' --query FailedEntryCount
0
$ aws events put-events --entries '[{"Source":"ridecore.spike","DetailType":"T","Detail":"{\"a\":1}"}]' --query FailedEntryCount
0
$ aws sqs receive-message --queue-url "$Q" --wait-time-seconds 3 --query 'Messages[0].Body' --output text
{"version":"0","id":"d9b8021a-24a9-4b74-bc22-5b5018335bd6","source":"ridecore.spike","detail-type":"T","account":"000000000000","time":"2026-11-09T22:05:27.993166292Z","region":"us-east-1","resources":[],"detail":{"a":1},"event-bus-name":"default"}

# DynamoDB Streams -> Lambda
$ python3 -c "import zipfile;zipfile.ZipFile('d.zip','w').write('ddb.mjs')"
$ aws lambda create-function --function-name ddb-h --runtime nodejs24.x --handler ddb.handler --role arn:aws:iam::000000000000:role/r --zip-file fileb://d.zip --query FunctionArn --output text
arn:aws:lambda:us-east-1:000000000000:function:ddb-h
$ ARN=$(aws dynamodb describe-table --table-name spike-cdk --query Table.LatestStreamArn --output text)
$ aws lambda create-event-source-mapping --function-name ddb-h --event-source-arn "$ARN" --starting-position TRIM_HORIZON --batch-size 1 --query State --output text
Enabled
$ aws dynamodb put-item --table-name spike-cdk --item '{"pk":{"S":"k1"},"x":{"S":"v"}}'
$ aws logs filter-log-events --log-group-name /aws/lambda/ddb-h --query 'events[].message' --output text
2026-11-09T22:05:32.550Z	664fd05b-8e2a-4576-a968-040b11911282	INFO	STREAM_EVENT {"Records":[{"eventID":"36a8dff3-f0ed-497b-b10f-b810069adf5c","eventName":"INSERT","eventVersion":"1.1","eventSource":"aws:dynamodb","awsRegion":"us-east-1","dynamodb":{"ApproximateCreationDateTime":1794261931,"Keys":{"pk":{"S":"k1"}},"NewImage":{"pk":{"S":"k1"},"x":{"S":"v"}},"SequenceNumber":"000000000000000000001","SizeBytes":100,"StreamViewType":"NEW_AND_OLD_IMAGE
# floci log
2026-11-09 22:05:03,036 INFO  [io.quarkus] floci 2.4.0 native (powered by Quarkus 3.40.1) started in 0.054s. Listening on: http://0.0.0.0:4566
```
</details>
