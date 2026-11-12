# README, ADRs and Demo Implementation Plan

**Goal:** Make the repo pass the spec's "first 2 minutes" test (§6): a first screen with badges, a Mermaid diagram and one command to run; the missing ADRs; and proof that it works (a scripted trip with its real output, a live-map screenshot, and a real agent requesting a trip through MCP).

**Architecture:** One new script (`scripts/demo-trip.ts`, `make demo`) drives a full trip through the HTTP API and prints each step. Coverage runs with Vitest's V8 provider (`make coverage`) and goes to the CI job summary. Everything else is documentation built from real runs: the screenshot and the agent transcript are captured, never written by hand.

**Tech Stack:** Node 26 TypeScript scripts, `@vitest/coverage-v8` 5.1.0 (dev), GitHub Actions, Mermaid in GitHub Markdown, Claude Code CLI (`claude -p`) for the agent example.

**Spec:** `docs/design/2026-11-09-ridecore-design.md` §6 (what a reader sees first), §7 ("`make demo` runs the scripted trip"), §9 step 4.

## Global Constraints

- Owner decisions (2026-11-11): proof = `make demo` with its real output in the README plus a live-map screenshot, no GIF and no downloaded recorder; MCP example = one real `claude -p` run with the ridecore server; coverage = measured in CI and shown in the job summary and the README, no external service, no coverage badge.
- "No client names anywhere (README included)." The Background paragraph names no former client or employer, and no employment.
- "No invented metrics or 'production-ready' language." Every number in the README (coverage %, test counts, fares, timings) comes from a run in this plan.
- "Over-engineering beyond what a technical reader can follow in 2 minutes" is an anti-goal: the first screen stays short.
- Code, docs and commits in English; commits without `Co-Authored-By`; no push without the owner's order.
- `npm audit --omit=dev` stays at 0 (the new package is a dev dependency).
- Screenshot and transcript: no token, email or personal data visible.

## Review Focus

1. **`make demo` on a stack where seeded drivers are busy or offline** (an earlier demo or e2e left one on a trip). It must reset the seeded drivers it uses, or fail with one clear line, never hang. Pinned in Task 2.
2. **README claims that drift from the code**: commands, Makefile targets, ADR statements about keys and conditions. Each ADR statement is checked against the file it names (Task 3); each README command is run (Task 5).
3. **The agent transcript leaking secrets**: the token travels in the MCP config's env and must not appear in the saved example. Pinned in Task 4.
4. **Coverage in CI failing the build by accident**: no thresholds in this plan; the step only reports. Pinned in Task 1.
5. **Mermaid that GitHub does not render** (unsupported syntax). Checked in Task 5 by rendering on GitHub after push, before merge.

---

### Task 1: Coverage

**Files:**
- Modify: `package.json` (devDependency `@vitest/coverage-v8` `5.1.0`, same version as `vitest`; script `"coverage": "vitest run --project unit --coverage"`), `vitest.config.ts` (`coverage: { provider: 'v8', include: ['src/**'], reporter: ['text-summary', 'json-summary'] }`), `Makefile` (target `coverage`, in `.PHONY`), `.github/workflows/ci.yml` (in the `checks` job, after unit tests: `npm run coverage` then append `coverage/coverage-summary.json` totals to `$GITHUB_STEP_SUMMARY` as a Markdown table), `.gitignore` (`coverage/` already ignored by eslint; add to `.gitignore` if missing).

- [ ] **Step 1:** `npm install -D @vitest/coverage-v8@5.1.0 && npm audit --omit=dev --audit-level=moderate` → expected `found 0 vulnerabilities`.
- [ ] **Step 2:** `make coverage` → expected: the text summary (Statements/Branches/Functions/Lines) and `coverage/coverage-summary.json`. Record the four percentages in the ledger: they are the numbers the README will quote, labelled "unit tests only".
- [ ] **Step 3:** Commit `ci: unit-test coverage in the job summary`.

### Task 2: `make demo` — a full trip, step by step

**Files:**
- Create: `scripts/demo-trip.ts`, `tests/unit/scripts/demo-trip.test.ts`
- Modify: `Makefile` (target `demo`: requires `.env.deploy` like `e2e`; `$(LOAD_ENV) && node scripts/demo-trip.ts`; in `.PHONY`)

**Interfaces:**
- Produces: `runDemoTrip(deps: { api: string; secret: string; fetch?: typeof fetch; print: (line: string) => void; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }): Promise<void>`; the script's main calls it with `RIDECORE_API_URL`, `RIDECORE_JWT_SECRET` and `console.log`.

The trip uses `passenger-1` and the seeded drivers (`DEMO_DRIVERS`, `DEMO_CENTRE` from `scripts/demo-drivers.ts`):
1. Put every seeded driver back at its seed position and `AVAILABLE` (`PUT /drivers/me/position`, `PUT /drivers/me/availability`). A driver that answers `DRIVER_ON_TRIP` is skipped with one printed line.
2. If `passenger-1` has an active trip (`GET /me/trips`, first item in an active state), cancel it with reason `demo reset`.
3. `POST /trips` from `DEMO_CENTRE` to a point ~2 km away; print id, state and fare estimate.
4. Poll `GET /drivers/me/offers` for each seeded driver every 1 s until one has an offer for this trip (it arrives through the dispatch consumer); print which driver and after how long. Past `timeoutMs` (default 60 s): print one line naming the dispatch queue and its DLQ (`make redrive QUEUE=dispatch`) and exit 1.
5. That driver: accept, arrive, start, complete; then the passenger rates 5. Print one line per step: action, resulting state, version.
6. Poll `GET /trips/{id}` until `finalFare` is set (billing consumer); print the final fare. Same timeout rule.

Output format, one line per step, e.g. `[ 3.2s] driver-2 accept       -> ACCEPTED        v2`. Tokens are minted with `signToken` and never printed.

- [ ] **Step 1: Failing unit tests** (fake `fetch` routing by method + path, `sleep` that resolves at once):
  - happy path: the printed lines name, in order, `REQUESTED`, the offered driver, `ACCEPTED`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `RATED` and the final fare; no printed line contains a token (`eyJ`).
  - an active trip of `passenger-1` is cancelled with `{"reason":"demo reset"}` before the new request.
  - a driver answering `409 DRIVER_ON_TRIP` on availability is skipped and the demo continues.
  - no offer within `timeoutMs` → rejects with an error whose message contains `make redrive QUEUE=dispatch`.
- [ ] **Step 2:** `npx vitest run --project unit tests/unit/scripts/demo-trip.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement. **Step 4:** tests pass; `make test` green.
- [ ] **Step 5:** `make demo` on Floci, twice in a row (the second run proves the reset). Expected: both reach `RATED` and print a final fare. Save the second run's output to the ledger workspace as `demo-output.txt` for Task 5.
- [ ] **Step 6:** Commit `feat: make demo runs a full trip through the API`.

### Task 3: ADRs 0006 and 0007

**Files:**
- Create: `docs/decisions/0006-single-table-design.md`, `docs/decisions/0007-idempotency-and-locking.md`

Same format as ADRs 0003-0005 (Date, Status: accepted, Context, Decision, Consequences), short (spec: "4-6 short ADRs").
- **0006:** why one table; the access patterns of spec §7 with the exact key or index that serves each (`src/infra/dynamo/keys.ts`); GSI1 and GSI2 and what shares them (passenger history, driver offers, connections by actor; availability cells, watch cells); sparse GSI2 keys for availability; TTL items; the stream and its two readers. Cost of the choice: key design is harder to read, and the stream has the recommended maximum of 2 readers.
- **0007:** Idempotency-Key (scope role + subject + key, request hash, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, stored response written in the same transaction, expiry); optimistic locking (`version` condition, `CONCURRENT_UPDATE`); one active trip per passenger/driver via reservation items in the transaction (`ACTIVE_TRIP_EXISTS`, `DRIVER_BUSY`, `TRIP_ALREADY_TAKEN`); consumer dedup (`CONSUMED#…`) as the at-least-once counterpart (link ADR 0004).

- [ ] **Step 1:** Write both. **Step 2:** For every code, key and number named, grep it in `src/` and note the file:line in the ledger; anything not found is removed or corrected. **Step 3:** Commit `docs: ADRs for the single-table design and for idempotency and locking`.

### Task 4: Proof captures (screenshot and agent transcript)

**Files:**
- Create: `docs/img/live-map.png`, `docs/mcp-example.md`

- [ ] **Step 1: Screenshot.** `make demo-map` (background), open `demo/map.html` in Chrome, connect with the printed URL and token (password field), wait until cars move, take the screenshot of the page, crop to the map and the side panel, save as PNG under 400 KB. Check: the token field shows only dots, the URL field shows a Floci local URL only.
- [ ] **Step 2: Agent run.** Write an MCP config to the scratchpad (not the repo) with the ridecore server (`node --import <repo>/scripts/load-env.ts <repo>/src/mcp/main.ts`, `RIDECORE_MCP_TOKEN` from `make -s mcp-token PASSENGER=mcp-demo-passenger`). Run once:
  `timeout 300 claude -p "<prompt>" --mcp-config <file> --strict-mcp-config --allowedTools "mcp__ridecore__request_trip,mcp__ridecore__get_trip_status,mcp__ridecore__cancel_trip,mcp__ridecore__list_my_trips" --output-format stream-json --verbose </dev/null > <scratch>/agent.jsonl`
  Prompt: "I'm at 2.4448, -76.6147 and need to go to 2.4594, -76.5996. Request a trip, tell me its status and the estimated fare, then cancel it because I changed my mind."
  Expected: the transcript shows calls to `request_trip`, `get_trip_status` (or the status from the request) and `cancel_trip`, and a final answer.
- [ ] **Step 3:** Write `docs/mcp-example.md` from the JSONL: the prompt, each tool call with its arguments and result (trimmed to the summary JSON), and the agent's final answer verbatim, plus the config snippet from the README. Header line: date, `claude` CLI version, and that it ran against the local Floci stack. `grep -c "eyJ" docs/mcp-example.md` → 0.
- [ ] **Step 4:** Commit `docs: live map screenshot and a real agent run over MCP`.

### Task 5: README first screen

**Files:**
- Modify: `README.md`

Order of the first screen: title; one-sentence description; badges (CI status from `.github/workflows/ci.yml` on `main`, license MIT, Node 26); "Run it": `npm ci && make up && make demo`; the Mermaid diagram (replaces the ASCII one: HTTP API → Lambda → DynamoDB → stream → publisher → EventBridge → SQS consumers / SNS → driver offers; notifier and positions → WebSocket API; MCP server → HTTP API); then "What it does today" (unchanged content, trimmed where it repeats the diagram).

Further down:
- "See it work": the `make demo` output from Task 2 (verbatim, in a code block), the screenshot, and three lines with a link to `docs/mcp-example.md`.
- "Tests and CI": add the coverage line with the Task 1 numbers, labelled "unit tests only", and `make coverage`.
- "Decisions": add 0006 and 0007; link all plans, not only the first.
- "Background" (one paragraph, end of file before License): ridecore is inspired by a ride-hailing platform the author designed and built in 2016-2018; this is a new codebase with no code, names or data from it. No client name.
- Roadmap: item 4 done; keep "Known limitations".

- [ ] **Step 1:** Write it. **Step 2:** Run every command the README shows that does not need a browser (`npm ci`, `make up`, `make demo`, `make coverage`, `make mcp-token`, `make e2e`) on the current stack; compare outputs with what the README says. **Step 3:** grep the README and `docs/` for "production-ready" and for the former client's and employers' names (the list lives outside the repo, in the owner's private notes; never write it into a tracked file) → nothing. **Step 4:** Commit `docs: README first screen, demo output and background`.
- [ ] **Step 5 (after push, before merge):** open the README on GitHub in the PR branch and check the Mermaid diagram and the screenshot render.
