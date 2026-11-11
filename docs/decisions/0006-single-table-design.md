# ADR 0006: One DynamoDB table, keys from access patterns

Date: 2026-11-11. Status: accepted.

## Context

The design spec (§7) asks for DynamoDB with the schema designed from access patterns. It lists five that are required: a trip by id, the active trip of a passenger, the active trip of a driver, a passenger's history (newest first), and the available drivers in an area. Plans 2a and 2b added offers, consumer dedup, billing, WebSocket connections and throttles.

## Decision

**One table, `ridecore`.** It has string keys `PK`/`SK`, two global secondary indexes (`GSI1`, `GSI2`), TTL on `expiresAt` and a `NEW_IMAGE` stream. The layout lives in one plain-data module, `src/infra/dynamo/keys.ts`. The CDK stack and the integration-test helper build the same table from it.

| Access pattern | Served by |
|---|---|
| Trip by id | `TRIP#<id>` / `META` |
| Active trip of a passenger / of a driver | reservation items `PASSENGER#<id>` / `ACTIVE` and `DRIVER#<id>` / `ACTIVE` (ADR 0007) |
| A passenger's history, newest first | GSI1 `PASSENGER#<id>`, sort `TRIP#<createdAt>#<id>`, queried backwards, 20 per page |
| Available drivers in an area | GSI2 `AVAIL#<geohash5>`, sort `DRIVER#<id>`, for the cell and its 8 neighbours |
| A driver's open offers | offer items `TRIP#<tripId>` / `OFFER#<driverId>`, found through GSI1 `DRIVER#<id>`, sort `OFFER#<createdAt>` |
| A trip's events (outbox) | `TRIP#<id>` / `EVENT#<version, 6 digits>`, written in the trip's transaction (ADR 0004) |
| Billing record | `TRIP#<id>` / `BILLING` |
| Consumer dedup | `CONSUMED#<consumer>` / `EVENT#<eventId>`, TTL 7 days |
| Idempotency keys | `IDEM#<role>#<subject>#<key>` / `META`, TTL 24 h (ADR 0007) |
| Sockets of one actor | GSI1 `CONNACTOR#<role>#<id>` on `CONN#<connectionId>` / `META`, TTL 2 h 10 min (ADR 0005) |
| Passengers watching a map cell | GSI2 `WATCH#<geohash5>`, sort `CONN#<connectionId>` |
| Throttle markers | `THROTTLE#<scope>#<id>` / `META` |

- **Everything about a trip shares its partition** (`TRIP#<id>`): the trip, its events, its offers and its billing record.
- **The indexes are overloaded by prefix.** GSI1 holds passenger history, driver offers and sockets by actor. GSI2 holds available drivers and watched cells. The prefixes never overlap, so each query reads only its own kind.
- **Availability is a sparse index.** A driver's `META` item carries the `GSI2` keys only while it is `AVAILABLE` and has a position. Going offline or taking a trip removes them, so the area query never sees a busy driver.
- **Expiry is TTL.** DynamoDB deletes expired items lazily, sometimes long after `expiresAt`.
  - **Idempotency records:** the code also checks `expiresAt`, so an expired key counts as absent at once.
  - **Dedup records and connection items:** they can linger until DynamoDB deletes them. A very late duplicate is still skipped, and a push to a dead socket gets a 410 that removes its item (ADR 0005).

## Consequences

- Most access patterns are one `GetItem` or one `Query`. There are two exceptions:
  - **Area search** runs one `Query` per cell: the cell and its 8 neighbours.
  - **A driver's offers** are one `Query` and then a `BatchGetItem` of the trips.
- Every multi-item change (a trip, its reservation, its event, an idempotency record) fits one `TransactWriteItems`. That is what ADR 0007 relies on.
- The cost is readability. The key formats are only clear with `keys.ts` open, which is why every key in it is a named function and this table exists.
- The stream now has two readers, the outbox publisher and the positions handler. That is the number AWS recommends as the maximum per stream. A third consumer would read from EventBridge, not from the stream.
- Area search is coarse: geohash precision 5 (cells of a few kilometres) plus neighbours, then distance in code. That is enough for the spec ("coarse geohash prefix is acceptable"), but not for a dense city.
