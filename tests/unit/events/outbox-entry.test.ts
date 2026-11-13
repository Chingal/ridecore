import { describe, expect, it } from 'vitest';
import { buildEntry } from '../../../src/events/outbox-entry.ts';
import { EVENT_SOURCE } from '../../../src/events/names.ts';

const ITEM = {
  schemaVersion: 1,
  eventId: 't-1:1',
  type: 'trip.requested',
  tripId: 't-1',
  version: 1,
  occurredAt: '2026-11-10T12:00:00.000Z',
  payload: { fromState: null, toState: 'REQUESTED', passengerId: 'p-1', fareEstimate: 7000 },
  correlationId: 'c-1',
  PK: 'TRIP#t-1',
  SK: 'EVENT#000001',
  entity: 'EVENT',
};

// Captured from the publisher before the shared builder existed: the event body must not change.
const GOLDEN_DETAIL =
  '{"schemaVersion":1,"eventId":"t-1:1","type":"trip.requested","tripId":"t-1","version":1,"occurredAt":"2026-11-10T12:00:00.000Z","payload":{"fromState":null,"toState":"REQUESTED","passengerId":"p-1","fareEstimate":7000},"correlationId":"c-1"}';

describe('buildEntry', () => {
  it('golden Detail: the event body is exactly what the stream publisher sent before', () => {
    const built = buildEntry(ITEM, 'ridecore');
    expect(built.entry).toEqual({ Source: EVENT_SOURCE, DetailType: 'trip.requested', EventBusName: 'ridecore', Detail: GOLDEN_DETAIL });
    expect(built.tripId).toBe('t-1');
    expect(built.correlationId).toBe('c-1');
  });

  it('strips index and debug attributes and returns the item key', () => {
    const built = buildEntry(
      { ...ITEM, GSI2PK: 'OUTBOX#3', GSI2SK: '2026-11-10T12:00:00.000Z#t-1#000001', publishedAt: '2026-11-10T12:00:01.000Z', outboxAttempts: 2 },
      'ridecore',
    );
    expect(built.entry.Detail).toBe(GOLDEN_DETAIL);
    expect(built.key).toEqual({ PK: 'TRIP#t-1', SK: 'EVENT#000001' });
  });

  it('omits correlationId when the event has none', () => {
    const withoutCorrelation: Record<string, unknown> = { ...ITEM };
    delete withoutCorrelation.correlationId;
    expect(buildEntry(withoutCorrelation, 'ridecore').correlationId).toBeUndefined();
  });
});
