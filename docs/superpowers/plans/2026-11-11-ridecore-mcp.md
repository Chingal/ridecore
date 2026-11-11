# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stdio MCP server that lets an AI agent request a trip, check its status, cancel it and list the passenger's trips by calling the real ridecore HTTP API with one passenger token.

**Architecture:** `src/mcp/` holds three layers: an HTTP client for the four passenger routes (`api-client.ts`), the tool definitions that turn API trips into small summaries and API errors into readable tool errors (`tools.ts`), and a stdio entry point (`main.ts`). The server never touches DynamoDB; the API's per-resource authorization applies unchanged. Nothing here ships in the Lambda bundle.

**Tech Stack:** Node.js 26 (TypeScript run natively, as the rest of the repo), `@modelcontextprotocol/sdk` 1.32.x (`McpServer`, `StdioServerTransport`; `Client`, `InMemoryTransport`, `StdioClientTransport` in tests), zod 4 (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-09-ridecore-design.md` (§2 goal 3, §5 "Authorization per resource", §7 "MCP server"), and `docs/decisions/0003-mcp-tool-design.md` (proposed; this plan implements it and marks it accepted).

## Global Constraints

- "MCP server: TypeScript, official MCP SDK, stdio transport. Tools: `request_trip`, `get_trip_status`, `cancel_trip`, `list_my_trips`. It calls the HTTP API (not the database directly). Tool inputs are validated; errors are returned as readable tool errors." (spec §7)
- "The MCP server acts on behalf of one passenger token and never widens it." (spec §5)
- ADR 0003: task-shaped tools only; small summarized results (trip id, state, origin, destination, fare estimate or final fare, timestamps), never raw items or other users' data; descriptions with one or two realistic input examples; no tool search, no code mode.
- Node >= 26.13.0; code also passes on Node 24 (CI job `node24`). TypeScript strict; `no-explicit-any` is an error in `src/`.
- Code, docs and commits in English. Commits without `Co-Authored-By`. No push without the owner's order.
- `npm audit --omit=dev --audit-level=moderate` must stay at 0 (CI step); the new dependency is a production dependency.
- No client names, no employment references anywhere.

## Review Focus

1. **Anything written to stdout except protocol frames breaks the session.** `main.ts`, the env loader and any log must write to stderr only. Pinned by the e2e test, which drives the real process over stdio (Task 4).
2. **A driver token, an expired token or a missing `RIDECORE_API_URL`.** The server must refuse to start with a one-line stderr message (missing env), and a driver/expired token must surface as a readable tool error (`FORBIDDEN_ROLE` / `UNAUTHENTICATED`), never a crash. Pinned in Task 3 (startup) and Task 4 (driver token through the real API).
3. **The API is down or slow.** A refused connection or a request past the timeout must come back as a tool error `API_UNAVAILABLE`, not hang the agent. Pinned in Task 1.
4. **The agent retries `request_trip`.** Each call sends a fresh `Idempotency-Key`; the second call while the first trip is active must return the API's one-active-trip error as a readable tool error, not a second trip. Pinned in Task 4.
5. **Leaking other people's data.** The summary must not carry `passengerId`, `driverId`, `version` or rating comments of anyone else; it only says whether a driver is assigned. Pinned in Task 2.

---

### Task 1: Dependency and API client

**Files:**
- Modify: `package.json`, `package-lock.json` (add `@modelcontextprotocol/sdk` `^1.32.2` to `dependencies`)
- Create: `src/mcp/api-client.ts`
- Test: `tests/unit/mcp/api-client.test.ts`

**Interfaces:**
- Produces:
  - `type ApiTrip = Trip` (re-export of `src/domain/trip.ts` `Trip`, the API's JSON body).
  - `class ApiError extends Error { status: number; code: string }` — `status` 0 for transport failures.
  - `interface ApiClient { requestTrip(input: { origin: LatLng; destination: LatLng }): Promise<Trip>; getTrip(tripId: string): Promise<Trip>; cancelTrip(tripId: string, reason?: string): Promise<Trip>; listMyTrips(): Promise<Trip[]> }`
  - `createApiClient(opts: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number; newKey?: () => string }): ApiClient`
  - `API_TIMEOUT_MS = 10_000`

- [ ] **Step 1: Add the dependency and check the audit**

Run: `npm install @modelcontextprotocol/sdk@^1.32.2 && npm audit --omit=dev --audit-level=moderate`
Expected: install succeeds; audit prints `found 0 vulnerabilities`. If not 0, stop and record the advisory as a ruling (the CI step would fail).

- [ ] **Step 2: Write the failing tests** (fake `fetch` capturing method, URL, headers, body)

- `requestTrip` sends `POST {baseUrl}/trips` with `authorization: Bearer <token>`, `content-type: application/json`, `idempotency-key: <newKey()>`, body `{"origin":…,"destination":…}`, and returns the 201 body.
- Two `requestTrip` calls send two different keys (default `newKey` is `randomUUID`).
- `getTrip('a/b')` requests `GET {baseUrl}/trips/a%2Fb` (the id is URI-encoded); a trailing `/` on `baseUrl` is not doubled.
- `cancelTrip(id, 'late')` sends `POST /trips/{id}/cancel` with body `{"reason":"late"}`; without a reason it sends no body and no `content-type`.
- `listMyTrips()` requests `GET /me/trips` and returns `body.items`.
- A `{"error":{"code":"TRIP_NOT_FOUND","message":"Trip not found"}}` 404 rejects with `ApiError` `{status: 404, code: 'TRIP_NOT_FOUND', message: 'Trip not found'}`.
- A non-JSON 502 rejects with `ApiError` `{status: 502, code: 'API_ERROR'}`.
- A `fetch` that rejects (connection refused), and one that never resolves with `timeoutMs: 50`, both reject with `ApiError` `{status: 0, code: 'API_UNAVAILABLE'}`; the message names the base URL and never the token.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run --project unit tests/unit/mcp/api-client.test.ts`
Expected: FAIL, cannot resolve `src/mcp/api-client.ts`.

- [ ] **Step 4: Implement `createApiClient` in `src/mcp/api-client.ts`**

Timeout with `AbortSignal.timeout(timeoutMs)`. Error body shape is the API's only one (`src/http/respond.ts` `errorJson`).

- [ ] **Step 5: Run them to see them pass, then the unit suite**

Run: `npx vitest run --project unit tests/unit/mcp/api-client.test.ts && make test`
Expected: PASS; `make test` green (typecheck included).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/mcp/api-client.ts tests/unit/mcp/api-client.test.ts
git commit -m "feat(mcp): HTTP client for the passenger routes"
```

### Task 2: The four tools

**Files:**
- Create: `src/mcp/tools.ts`
- Test: `tests/unit/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `ApiClient`, `ApiError` (Task 1).
- Produces:
  - `type TripSummary = { tripId: string; state: TripState; origin: LatLng; destination: LatLng; fareEstimate: number; finalFare?: number; currency: 'COP'; driverAssigned: boolean; cancelledBy?: 'passenger' | 'driver'; createdAt: string; timestamps: Partial<Record<TripState, string>> }`
  - `summarize(trip: Trip): TripSummary`
  - `createMcpServer(api: ApiClient): McpServer` — name `ridecore`, version from `package.json` (`0.1.0`), registers the four tools.
  - `LIST_LIMIT = 20` (what the API returns; stated in the tool description).

Tool contracts (zod input schemas; snake_case names as in the spec):

| Tool | Input | Result text |
|---|---|---|
| `request_trip` | `origin`, `destination`: `{lat: -90..90, lng: -180..180}` | JSON of `TripSummary` |
| `get_trip_status` | `trip_id`: non-empty string, max 128 | JSON of `TripSummary` |
| `cancel_trip` | `trip_id`; `reason`: optional string 1..200 | JSON of `TripSummary` |
| `list_my_trips` | none | JSON `{ trips: TripSummary[] }`, newest first |

Every result also sets `structuredContent` to the same object. Errors: `ApiError` → `{ isError: true, content: [{ type: 'text', text: '<code>: <message>' }] }`; any other error → `INTERNAL: unexpected error` (the stack goes to stderr, not to the model). Each description says what the tool does, that fares are in Colombian pesos, and carries examples, e.g. `request_trip`: `{"origin":{"lat":2.4448,"lng":-76.6147},"destination":{"lat":2.4594,"lng":-76.5996}}`; `cancel_trip`: "only while the trip is REQUESTED, ACCEPTED or DRIVER_ARRIVED; once IN_PROGRESS it cannot be cancelled".

- [ ] **Step 1: Write the failing tests** (a real SDK `Client` connected through `InMemoryTransport.createLinkedPair()` to `createMcpServer(fakeApi)`)

- `listTools` returns exactly `['cancel_trip', 'get_trip_status', 'list_my_trips', 'request_trip']` (sorted), each with a description containing `"lat"` or `trip_id` examples where it takes input.
- `request_trip` with Popayán points calls `fakeApi.requestTrip` with `{origin, destination}` and returns `structuredContent` equal to `summarize(trip)`.
- `summarize` of a trip with `passengerId`, `driverId`, `version`, `rating` gives `driverAssigned: true` and none of those four keys (`expect(Object.keys(s)).not.toContain(...)`); a CANCELLED trip gives `cancelledBy` and no `reason`.
- `get_trip_status` with `trip_id: ''` and `request_trip` with `lat: 91` are rejected before the fake is called (`isError: true` or protocol error, and `fakeApi` calls are 0).
- `cancel_trip` on a fake that throws `new ApiError(409, 'INVALID_TRANSITION', 'Cannot CANCEL a trip in state IN_PROGRESS')` returns `isError: true` with text `INVALID_TRANSITION: Cannot CANCEL a trip in state IN_PROGRESS`.
- A fake that throws `new Error('boom at /secret/path')` returns text `INTERNAL: unexpected error` (no `boom`, no path).
- `list_my_trips` returns `{ trips: [...] }` in the order the API gave.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit tests/unit/mcp/tools.test.ts`
Expected: FAIL, cannot resolve `src/mcp/tools.ts`.

- [ ] **Step 3: Implement `summarize` and `createMcpServer` in `src/mcp/tools.ts`** with `server.registerTool(name, { title, description, inputSchema, outputSchema }, handler)`.

- [ ] **Step 4: Run them to see them pass, then the unit suite**

Run: `npx vitest run --project unit tests/unit/mcp/tools.test.ts && make test`
Expected: PASS; green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/unit/mcp/tools.test.ts
git commit -m "feat(mcp): request, status, cancel and list tools with summarized results"
```

### Task 3: stdio entry point

**Files:**
- Create: `src/mcp/main.ts`, `src/mcp/config.ts`
- Modify: `package.json` (script `"mcp": "node --import ./scripts/load-env.ts src/mcp/main.ts"`), `Makefile` (target `mcp-token`: prints a passenger token for `PASSENGER ?= demo-passenger-1` via `npm run --silent token -- passenger $(PASSENGER)`; add to `.PHONY`)
- Test: `tests/unit/mcp/config.test.ts`

**Interfaces:**
- Consumes: `createApiClient` (Task 1), `createMcpServer` (Task 2).
- Produces: `readConfig(env: NodeJS.ProcessEnv): { baseUrl: string; token: string }` — reads `RIDECORE_API_URL` and `RIDECORE_MCP_TOKEN`; throws `Error` naming the missing variable (never printing the token); rejects a `RIDECORE_API_URL` that is not `http:`/`https:`.

- [ ] **Step 1: Write the failing tests** for `readConfig`: both set → values; each missing or empty → error message contains its name; `ftp://x` → error; the error for a malformed URL does not contain the token value.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project unit tests/unit/mcp/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `readConfig` and `main.ts`**

`main.ts`: `readConfig(process.env)`; on error write `ridecore-mcp: <message>` to stderr and exit 1. Otherwise connect `createMcpServer(createApiClient(config))` to `new StdioServerTransport()`. Nothing in this file or its imports writes to stdout. Check `scripts/load-env.ts` stays silent without `--print` (it is).

- [ ] **Step 4: Run tests, then a startup smoke check**

Run: `npx vitest run --project unit tests/unit/mcp/config.test.ts && make test && env -u RIDECORE_MCP_TOKEN npm run --silent mcp </dev/null; echo "exit=$?"`
Expected: PASS; green; stderr `ridecore-mcp: RIDECORE_MCP_TOKEN is not set …`, `exit=1`, nothing on stdout.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/main.ts src/mcp/config.ts tests/unit/mcp/config.test.ts package.json Makefile
git commit -m "feat(mcp): stdio entry point and config"
```

### Task 4: e2e through the real process and the real API

**Files:**
- Create: `tests/e2e/mcp.test.ts`

**Interfaces:**
- Consumes: the `mcp` entry (`node --import ./scripts/load-env.ts src/mcp/main.ts`), `signToken`, `createDeps` (cleanup only, as in `tests/e2e/realtime.test.ts`).

The test spawns the server with `StdioClientTransport({ command: process.execPath, args: ['--import', './scripts/load-env.ts', 'src/mcp/main.ts'], env: { ...process.env, RIDECORE_MCP_TOKEN: <token> }, stderr: 'pipe' })` and talks to it with an SDK `Client`. It runs against `RIDECORE_API_URL`, so `make e2e` (Floci Lambda) and `make e2e-local` (local adapter) both cover it.

- [ ] **Step 1: Write the test**

1. `listTools` has the four names.
2. `request_trip` from a jittered point near Popayán (away from the other e2e files' areas) → `state: 'REQUESTED'`, `driverAssigned: false`, `fareEstimate > 0`.
3. A second `request_trip` → `isError: true`, text starts with `ACTIVE_TRIP_EXISTS`.
4. `get_trip_status` → same `tripId`, `REQUESTED`.
5. `list_my_trips` → first item has that `tripId`.
6. `cancel_trip` with `reason: 'changed plans'` → `CANCELLED`, `cancelledBy: 'passenger'`.
7. `cancel_trip` again → `isError: true`, text starts with `INVALID_TRANSITION`.
8. A second server started with a **driver** token: `list_my_trips` → `isError: true`, text starts with `FORBIDDEN_ROLE`.
9. A server started with the passenger token and `get_trip_status` on another passenger's trip (created with `deps`) → `TRIP_NOT_FOUND`.

`afterAll` closes the clients and cancels any trip left active.

- [ ] **Step 2: Prove it can fail**

Run `make e2e-local E2E_ARGS=tests/e2e/mcp.test.ts` once with `cancel_trip` temporarily wired to `getTrip` in `tools.ts`.
Expected: FAIL at step 6 (state is `REQUESTED`). Revert the change.

- [ ] **Step 3: Run it green on both targets**

Run: `make e2e-local E2E_ARGS=tests/e2e/mcp.test.ts && make e2e E2E_ARGS=tests/e2e/mcp.test.ts`
Expected: PASS on both.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/mcp.test.ts
git commit -m "test(mcp): e2e over stdio against the real API"
```

### Task 5: Docs

**Files:**
- Modify: `docs/decisions/0003-mcp-tool-design.md` (Status → accepted, built in Plan 3; a "Built" section: summary fields, error format, `Idempotency-Key` per call and why the one-active-trip rule stops duplicate trips, tokens never logged, limits: 20 trips, no rating tool, no streaming of updates)
- Modify: `README.md` (status line; "What it does today" bullet for MCP; a "Use it from an AI agent" section with `make mcp-token` and a Claude Code config using `node --import ./scripts/load-env.ts src/mcp/main.ts` — not `npm run`, whose banner would go to stdout — and one example exchange; roadmap item 3 struck "Done")

- [ ] **Step 1: Write the docs.** Every claim must match the code and the e2e test; no invented numbers.
- [ ] **Step 2: Check them**

Run: `make lint && make test && make mcp-token >/dev/null && echo ok`
Expected: green and `ok`; every command the README names exists in `package.json` or `Makefile` (the e2e test of Task 4 is the proof that the flow works).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/decisions/0003-mcp-tool-design.md
git commit -m "docs: MCP server usage and ADR 0003 accepted"
```
