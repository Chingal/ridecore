# ADR 0003: MCP server tool design

Date: 2026-11-10. Status: proposed (implemented in Plan 3).

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

## Revisit when

- The server grows past about 10 tools, or its definitions pass about 10K tokens: add deferred loading / tool search.
- Agents start chaining many calls over large results (for example, "summarize my last 100 trips"): add a code-execution path so intermediate data stays out of the model's context.

## References

- Cloudflare, "Code Mode: give agents an entire API in 1,000 tokens" (2026-02-20): https://blog.cloudflare.com/code-mode-mcp/
- Anthropic, "Code execution with MCP" (2025-11-04): https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic, "Introducing advanced tool use" (2025-11-24): https://www.anthropic.com/engineering/advanced-tool-use
