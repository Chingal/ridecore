# Review checklist

A living list of the mistakes reviews have actually found in this repo. Each category is a class of mistake, not a single bug: it is recorded once, then prevented.

**How it is used**
- **Before writing code:** read the categories that touch the files you are changing.
- **When reviewing:** walk every category against the diff. Each finding cites one (`C7`), or is proposed as a new category.
- **New categories:** added only from a real finding, with its source. They are reviewed before they land.

**Enforced by** says what catches the mistake today: a static rule, a test, or only a reviewer. The goal is to move every category toward a deterministic check, so reviews spend their time on what tools cannot see. "Reviewer" means no automated check exists yet.

---

## Data leaving the process

### C1. Redact secrets before anything leaves the process
- **Rule:** Telemetry, error reports and outbound payloads never carry bearer tokens, JWTs, keys or request bodies. Redact every field that can hold client data (message, error name, tags, stack frames), not only the obvious one.
- **Why:** A token in an error tracker is a credential leak to a third party, and it outlives the request.
- **Example:** reporting `path: /trips/<jwt>/cancel` leaks the token; report the route name `cancelTrip` instead.
- **Source:** #20 (review rounds 1–4).
- **Enforced by:** tests (`tests/unit/error-report.test.ts`); reviewer.

### C2. Bound a value before redacting it, without cutting a secret in half
- **Rule:** When truncating text that will be redacted, drop the token-shaped run touching the cut. A token cut in half no longer matches the token pattern.
- **Why:** The fragment still carries the decodable header and claims.
- **Example:** `slice(0, 2048)` then a three-segment regex lets `eyJhbGci….eyJzdWIi…` through.
- **Source:** #20 (Fable review, automated security review).
- **Enforced by:** tests (`tests/unit/error-report.test.ts`).

### C3. Outbound calls to configured endpoints refuse redirects
- **Rule:** An HTTP call that carries a key or private data uses `redirect: 'error'` (or validates the target), and only `http`/`https` URLs are accepted.
- **Why:** A redirect sends the payload and its auth header to another origin.
- **Source:** #20 (review round 1).
- **Enforced by:** tests; reviewer.

## Configuration and the request path

### C4. Optional features fail open; required configuration fails closed
- **Rule:** A malformed optional setting turns that feature off with a warning that never echoes the value. A missing or weak required setting (table name, JWT secret) fails at startup.
- **Why:** A typo in telemetry configuration must not take the API down. A missing secret must never fall back to a default.
- **Example:** an invalid `SENTRY_DSN` used to throw at module init and fail the Lambda cold start.
- **Source:** #20 (review round 1); `jwtSecretFromEnv` in `src/http/deps.ts`.
- **Enforced by:** tests (`tests/unit/error-report.test.ts`, `tests/unit/http/deps.test.ts`).

### C5. Nothing optional sits on the critical path of a request
- **Rule:** Telemetry and other best-effort work never delays or replaces the response. Do not await it, bound it with a timeout, and catch synchronous and asynchronous failures.
- **Why:** A stalled collector would turn every 500 into a timeout.
- **Source:** #20 (review rounds 1–2).
- **Enforced by:** tests (`tests/unit/http/error-reporting.test.ts`).

### C6. Bound untrusted input before regexes and parsing
- **Rule:** Limit the length of client-controlled text before running a regex over it, and avoid patterns that backtrack (`\/+$`, nested quantifiers) on unbounded input.
- **Why:** A 40,000-character message made redaction take seconds; static analysis flags the same pattern class (S8786).
- **Source:** #8 (SonarQube S8786), #20 (review round 3).
- **Enforced by:** SonarQube (S8786); tests.

### C7. Decode untrusted encodings strictly
- **Rule:** Decode client bytes with a strict decoder (`new TextDecoder('utf-8', { fatal: true })`) and reject invalid input with a 4xx.
- **Why:** A lenient decode silently replaces bytes with `U+FFFD` and accepts data the client never sent.
- **Source:** #10 (fixed in #18).
- **Enforced by:** tests (`tests/unit/http/validate.test.ts`).

## Time, state and concurrency

### C8. Check time boundaries for inclusive versus exclusive, and for unit truncation
- **Rule:** When comparing a deadline, decide whether the boundary instant is inside or outside, and compare in the same unit. Truncating milliseconds to seconds and then using `>=` adds a second.
- **Why:** A 30-second lease blocked retries during second 31.
- **Source:** #11 (fixed in #19).
- **Enforced by:** tests (`tests/unit/infra/idempotency-lease.test.ts`).

### C9. A state transition validates its invariants, including under concurrent requests
- **Rule:** Each transition checks what must already be true (order of timestamps, current state) inside the same conditional write, not before it.
- **Why:** A `/complete` racing a `/start` produced a trip completed before it started.
- **Source:** #12.
- **Enforced by:** reviewer (a test per transition is expected with the fix).

### C10. An idempotent replay returns exactly what the first request stored
- **Rule:** The response saved for an idempotency key is built from the state that request wrote, not from a value read earlier.
- **Why:** A replay of an availability change returned a stale position.
- **Source:** #13.
- **Enforced by:** reviewer.

### C11. A failed attempt never consumes its own retry
- **Rule:** When a retry budget or dedup marker is updated, update it only after the attempt succeeds, or roll it back on failure.
- **Why:** A failed `car.left` push marked the socket as notified, so it was never retried.
- **Source:** #14.
- **Enforced by:** reviewer.

### C12. Late events are checked against current ownership before delivery
- **Rule:** Real-time events carry the entity they belong to (trip, zone) and are dropped if that is no longer current for the receiver.
- **Why:** A late position from trip A reached the passenger of trip B; a late `watch` sent cars from the previous zone.
- **Source:** #15; Codex edge-case report (watch, untested).
- **Enforced by:** reviewer.

### C13. Deduplicate before a batched transactional write
- **Rule:** Items gathered from overlapping queries (neighbouring cells, retries) are deduplicated by key before they go into one transaction.
- **Why:** DynamoDB rejects a transaction with two operations on the same item, so one duplicate driver failed the whole offer batch.
- **Source:** #16.
- **Enforced by:** reviewer.

## Tests and scope

### C14. Tests never depend on what a random value happens to contain
- **Rule:** Assert the shape of a generated value (UUID format, length), not the absence of a substring.
- **Why:** `not.toContain('bad')` failed when a random UUID contained `…2bad5…`, failing CI on an unrelated PR.
- **Source:** #20 (flaky failure seen on #19).
- **Enforced by:** reviewer.

### C15. A fix changes only what its issue asks
- **Rule:** Behaviour outside the issue (another endpoint, another event, a shared helper used elsewhere) changes only with its own issue, or is called out explicitly in the PR.
- **Why:** A fix for #12 also changed the recorded time of cancellations, which nobody asked for.
- **Source:** #12 (blocked by review).
- **Enforced by:** reviewer.

### C16. Make intentional patterns explicit to static analysis
- **Rule:** When code relies on something a rule flags (using the index in `.map`), write it explicitly instead of suppressing the rule.
- **Why:** An explicit `(e, i) => tagExtra(e, i)` documents the intent and keeps the rule useful.
- **Source:** #8 (SonarQube S7727, fixed in #9).
- **Enforced by:** SonarQube (S7727).
