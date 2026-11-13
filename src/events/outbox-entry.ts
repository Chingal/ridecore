import type { PutEventsRequestEntry } from '@aws-sdk/client-eventbridge';
import { EVENT_SOURCE } from './names.ts';

/** Attributes of an outbox item that belong to storage, the pending index or debugging, never to the event. */
const NOT_EVENT_ATTRIBUTES = new Set(['PK', 'SK', 'entity', 'GSI2PK', 'GSI2SK', 'publishedAt', 'outboxAttempts']);

export type OutboxKey = { PK: string; SK: string };

export type BuiltEntry = { key: OutboxKey; tripId: string; correlationId?: string; entry: PutEventsRequestEntry };

/**
 * The EventBridge entry for one outbox item, shared by the stream publisher and the reconciler so
 * both paths publish the same body: every attribute of the item except the storage, index and
 * debug ones.
 */
export function buildEntry(item: Record<string, unknown>, busName: string): BuiltEntry {
  const event = Object.fromEntries(Object.entries(item).filter(([key]) => !NOT_EVENT_ATTRIBUTES.has(key)));
  return {
    key: { PK: String(item.PK), SK: String(item.SK) },
    tripId: String(event.tripId),
    ...(typeof event.correlationId === 'string' ? { correlationId: event.correlationId } : {}),
    entry: { Source: EVENT_SOURCE, DetailType: String(event.type), EventBusName: busName, Detail: JSON.stringify(event) },
  };
}
