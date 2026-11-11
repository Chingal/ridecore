# ADR 0003: MCP server tool design

Date: 2026-11-10. Status: accepted (built in Plan 3, 2026-11-11).

## Context

ridecore exposes trips to AI agents through an MCP server (design spec, "MCP server"). The HTTP API has more operations than an agent needs: passenger and driver routes, every state transition, ratings.

Two ways to expose an API to an agent:

1. **One tool per endpoint.** Simple to generate, but every tool definition sits in the model's context before any work starts, and the model has more wrong choices. Cloudflare measured its own API (2,500+ endpoints) at about 1.17 million tokens this way.
2. **A few task-shaped tools**, or, at large scale, a code interface where the model writes code against a typed API in a sandbox and only the final result returns (Cloudflare "Code Mode"; Anthropic "code execution with MCP", where one task dropped from 150,000 to 2,000 tokens).

Anthropic's own guidance is that tool search and programmatic calling pay off with large libraries (roughly 10+ tools or 10K+ tokens of definitions) and long call chains, and add cost (a search round-trip, a secure sandbox) below that.

## Decision

Expose **four task-shaped tools**, not one per endpoint: `request_trip`, `get_trip_status`, `cancel_trip`, `list_my_trips`.

- **Shaped around what a passenger asks**, not around routes. Driver and rating operations are not exposed.
- **Small, summarized results.** Tools return the fields an agent needs to answer (trip id, state, origin, destination, fare estimate or final fare, timestamps), never raw DynamoDB items or other users' data.
- **Descriptions with examples.** Each tool description includes one or two realistic input examples for the cases the JSON Schema cannot express (for example, cancelling only while the trip is still cancellable).
- **One identity.** The server acts with a single passenger token and calls the HTTP API, so the API's per-resource authorization applies unchanged (see the design spec, "Authorization per resource").
- **Readable errors.** Validation and state errors come back as tool errors the model can explain, not stack traces.
- **No tool search and no code mode for now.** With four compact tools both would add latency and a sandbox to protect for no measurable gain.

## Built

`src/mcp/`, run with `npm run mcp` or `node --import ./scripts/load-env.ts src/mcp/main.ts`:

- **Configuration.** `RIDECORE_API_URL` and `RIDECORE_MCP_TOKEN` (a passenger token). If either is missing, the server exits with a one-line message on stderr. The token is never logged or put in an error.
- **stdout is the protocol.** Every message of the server's own goes to stderr. The e2e test runs the server as a child process over stdio, so a stray line on stdout would fail it.
- **Summaries.** Each tool returns a `TripSummary`, as JSON text and as `structuredContent` with an output schema: `tripId`, `state`, `origin`, `destination`, `fareEstimate`, `finalFare` when there is one, `currency: "COP"`, `driverAssigned`, `cancelledBy` when cancelled, `createdAt` and the time of each state. It leaves out the passenger and driver ids, the version, the rating and the cancellation reason.
- **Errors.** An API error comes back as a tool error with the text `<code>: <message>` (for example `INVALID_TRANSITION: ...`). An unreachable or slow API (10 s) is `API_UNAVAILABLE`, and anything else is `INTERNAL: unexpected error`, with the detail on stderr only. Invalid input (coordinates out of range, an empty `trip_id`, a reason over 200 characters) is rejected by the input schema before any request.
- **Retries.** Each `request_trip` call sends a new `Idempotency-Key`. A key per call does not stop a second trip if the agent retries. What stops it is the one-active-trip rule: the second request fails with `ACTIVE_TRIP_EXISTS`.
- **Proof.** The e2e test (`tests/e2e/mcp.test.ts`) runs against the Floci-deployed Lambda and against the local adapter. It covers:
  - request, a second request refused, status, list, cancel, and a second cancel refused;
  - a driver token getting `FORBIDDEN_ROLE`;
  - another passenger's trip coming back as `TRIP_NOT_FOUND`.

**Limits.**
- `list_my_trips` returns the 20 most recent trips, the API's page size, with no paging.
- There is no rating tool, and no push of trip updates to the agent: it asks again.
- The token is a 24-hour dev token. When it expires, the tools answer `UNAUTHENTICATED`.

## Revisit when

- The server grows past about 10 tools, or its definitions pass about 10K tokens: add deferred loading / tool search.
- Agents start chaining many calls over large results (for example, "summarize my last 100 trips"): add a code-execution path so intermediate data stays out of the model's context.

## References

- Cloudflare, "Code Mode: give agents an entire API in 1,000 tokens" (2026-02-20): https://blog.cloudflare.com/code-mode-mcp/
- Anthropic, "Code execution with MCP" (2025-11-04): https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Introducing advanced tool use" (2025-11-24): https://www.anthropic.com/engineering/advanced-tool-use
