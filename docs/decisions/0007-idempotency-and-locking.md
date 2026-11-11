# ADR 0007: Idempotency keys, optimistic locking and one active trip

Date: 2026-11-11. Status: accepted.

## Context

Mobile clients retry, two drivers can tap "accept" at the same moment, and the spec allows one active trip per passenger and per driver. These rules have to hold with many Lambdas running at once, without a lock server and without reading first and then writing.

## Decision

**Optimistic locking on the trip.** Every trip has a `version`. A transition writes the new trip with the condition `#version = :expected` (the version it read) and increments it. If another write got there first, the condition fails and the request gets `409 CONCURRENT_UPDATE`. The client then reads the trip again and decides. The new version is also the event's version, so consumers and WebSocket clients can order and drop stale updates (ADR 0004, ADR 0005).

**One active trip, enforced in the same transaction.** Requesting a trip writes three things in one `TransactWriteItems`: the trip, its outbox event and a reservation item `PASSENGER#<id>` / `ACTIVE` that must not exist yet. Accepting writes `DRIVER#<id>` / `ACTIVE` the same way. When a condition fails, DynamoDB's cancellation reasons map to one error, by priority:
1. a stale version: `CONCURRENT_UPDATE`;
2. the passenger's reservation: `ACTIVE_TRIP_EXISTS`;
3. the driver's reservation: `DRIVER_BUSY`;
4. an existing trip id: `TRIP_ALREADY_EXISTS`.

The driver who loses an accept race gets `409 TRIP_ALREADY_TAKEN`. Finishing or cancelling a trip deletes its reservations in the same transaction.

**Idempotency keys on mutating requests.**
- **Header and scope.** The `Idempotency-Key` header is required on `POST /trips` and optional on the other mutating routes. The stored record is `IDEM#<role>#<subject>#<key>`, so the same key from a passenger and from a driver never collide. Subject and key are URI-encoded, so neither can contain the `#` separator.
- **Claim.** The first request claims the key with a conditional put. The claim records:
  - a SHA-256 hash of the method, the path and the canonical body;
  - a 30-second lease;
  - an expiry 24 hours later.
- **Response written with the change.** The response is written inside the business transaction, as one more item of it. Once the trip change commits, its response is stored, so a retry after a crash replays the response instead of running the change twice.
- **Errors.**
  - The same key with a different request: `422 IDEMPOTENCY_KEY_REUSED`.
  - The same key while the first request is still running: `409 REQUEST_IN_PROGRESS`.
  - A request whose lease ran out and was taken over by a retry cannot commit, because the owner condition fails.

**Consumers dedup by event id.** Delivery from SQS is at-least-once. Each consumer records `CONSUMED#<consumer>` / `EVENT#<eventId>` with a conditional put (TTL 7 days) and skips events it has already handled (ADR 0004). This is the asynchronous counterpart of idempotency keys.

## Consequences

- There are no read-then-write checks, and every rule is one conditional transaction. Integration tests run them against DynamoDB in Floci: two concurrent accepts, an accept racing a cancel, concurrent duplicates of one key, and a second trip for a passenger who already has one.
- Clients have to handle `409` as "read again". The API documents each code, and the MCP server passes them to the agent as readable errors (ADR 0003).
- A transaction holds at most 100 items. The largest one, an accept that retires every outstanding offer, is capped at 25 by limiting offers to 20 per trip.
- The idempotency record lives 24 hours. A retry after that runs the request again, and the one-active-trip rule is what then stops a duplicate trip.
