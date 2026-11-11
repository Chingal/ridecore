# ADR 0005: Real-time updates over WebSocket

Date: 2026-11-11. Status: accepted.

## Floci spike

Before building the real-time layer (Plan 2b) we checked each piece on Floci 2.4.0 (`ridecore-floci-1`, port 4567). We used a throwaway osls service with one Node 24 Lambda on `$connect`, `$disconnect` and `$default`, AWS CLI 1.46.3 in a throwaway venv, dummy credentials, and Node 26's global `WebSocket` as the client. All spike resources were removed afterwards.

| Check | Result | Evidence |
|---|---|---|
| (a) osls `websocket` events deploy; client URL | **Pass**, subdomain URL only | `Service deployed to stack spkws-dev`. `ws://<apiId>.execute-api.localhost.floci.io:4567/<stage>` opens and runs `$connect`; `localhost.floci.io` and its subdomains resolve to loopback through public DNS. The path form `ws://localhost:4567/_aws/execute-api/<apiId>/<stage>` is **not** upgraded: Floci serves it as plain HTTP and invokes `$default` with no `connectionId` |
| (b) What `$connect` receives; token transport | **Pass**, both ways | `headers['sec-websocket-protocol']` = `"ridecore.v1, tok.en-123_abc"`. Returning `Sec-WebSocket-Protocol: ridecore.v1` keeps the socket open (`ws.protocol === 'ridecore.v1'`). `queryStringParameters` carries `?token=…` (plus `stage`). Returning `statusCode: 401` makes the client's open fail |
| (c) `PostToConnection` from a Lambda | **Pass** with the subdomain endpoint | Inside the Lambda `AWS_ENDPOINT_URL` is `http://localhost.floci.io:4566`. Endpoint `http://<apiId>.execute-api.localhost.floci.io:4566/<stage>` → the client received `subEp:hello`. On AWS the form is `https://<apiId>.execute-api.<region>.amazonaws.com/<stage>`. Two other endpoints fail: `AWS_ENDPOINT_URL` itself → `UnknownOperationException` 404; the path form `…/_aws/execute-api/<apiId>/<stage>` → "ok", but nothing is delivered and Floci invokes `$default` with the posted body |
| (d) Post to a closed or unknown connection | **Pass** | `GoneException` 410 |
| (e) `$default` receives the client's message | **Pass** | `body: "hello"`, with `connectionId` |
| (f) A second stream mapping with its own filter | **Pass** | Two functions on one stream, with filters `entity: EVENT` (INSERT) and `entity: DRIVER` (INSERT, MODIFY). After writing an EVENT item, a DRIVER item, a TRIP item, then modifying the DRIVER and EVENT items: the first saw `[INSERT e2]`, the second `[INSERT d2, MODIFY d2]`, and the TRIP item reached neither. Records written while a new `LATEST` mapping was still starting were skipped, and one batch arrived twice |
| (g) Node 26 `WebSocket` as the test client | **Pass** | Rows (a), (b) and (c) ran with it |
| (h) The WebSocket API id inside the functions | **Pass** | `environment: WS_API_ID: !Ref WebsocketsApi` resolved to the deployed id (`deb1eebd4a`) in every invocation |

**Consequences:**
- **No fallback needed.** The local `ws` adapter of spec §5b is not built. The WebSocket API runs on Floci like it does on AWS.
- **Token transport: subprotocol.** The client offers `["ridecore.v1", <jwt>]` and `$connect` answers `Sec-WebSocket-Protocol: ridecore.v1`. Browsers cannot send an `Authorization` header on a WebSocket. A query-string token would end up in URLs and access logs, so we don't use it.
- **Management endpoint.** The functions get `RIDECORE_WS_API_ID` (`!Ref WebsocketsApi`) and `RIDECORE_WS_STAGE` (`${sls:stage}`) and build the endpoint in one function:
  - when `AWS_ENDPOINT_URL` is set (Floci): `<scheme>://<apiId>.execute-api.<that host>/<stage>`;
  - otherwise (AWS): `https://<apiId>.execute-api.<region>.amazonaws.com/<stage>`.
- **`$default` without a `connectionId` is ignored.** On Floci that is an HTTP request, not a socket message. During the spike, a handler that pushed on every `$default` triggered itself through the path-form endpoint and ran in a loop until we removed it.
- **Start the positions mapping before seeding.** Each mapping keeps its own filter. A `LATEST` mapping skips records written while it starts, so `make up` seeds after deploying.
