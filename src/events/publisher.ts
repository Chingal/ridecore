import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry, type PutEventsResultEntry } from '@aws-sdk/client-eventbridge';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { jsonLog, type Logger } from '../log.ts';
import { EVENT_BUS_NAME, EVENT_SOURCE } from './names.ts';

export { EVENT_SOURCE } from './names.ts';

/** PutEvents accepts at most 10 entries per call. */
const PUT_EVENTS_MAX = 10;

/** Storage attributes of an outbox item that are not part of the event. */
const STORAGE_ATTRIBUTES = new Set(['PK', 'SK', 'entity']);

export type OutboxEntry = { sequenceNumber: string; tripId: string; correlationId?: string; entry: PutEventsRequestEntry };

/**
 * The outbox events among stream records (INSERTs of `entity: 'EVENT'` items), in stream order, as
 * EventBridge entries. Everything else (trip updates, offers, idempotency records) is skipped, so a
 * stream mapping without its filter still publishes only events.
 */
export function outboxEntries(records: DynamoDBRecord[], busName: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  for (const record of records) {
    const image = record.dynamodb?.NewImage;
    const sequenceNumber = record.dynamodb?.SequenceNumber;
    if (record.eventName !== 'INSERT') continue;
    // The table stream is NEW_IMAGE: an INSERT without its image means the stream is misconfigured,
    // and skipping it could drop an outbox event, so fail loudly instead.
    if (image === undefined || sequenceNumber === undefined) throw new Error('Stream INSERT record without NewImage or SequenceNumber');
    const item = unmarshall(image as Record<string, AttributeValue>);
    if (item.entity !== 'EVENT') continue;
    const event = Object.fromEntries(Object.entries(item).filter(([key]) => !STORAGE_ATTRIBUTES.has(key)));
    entries.push({
      sequenceNumber,
      tripId: String(event.tripId),
      ...(typeof event.correlationId === 'string' ? { correlationId: event.correlationId } : {}),
      entry: { Source: EVENT_SOURCE, DetailType: String(event.type), EventBusName: busName, Detail: JSON.stringify(event) },
    });
  }
  return entries;
}

export type PublisherDeps = {
  send: (entries: PutEventsRequestEntry[]) => Promise<PutEventsResultEntry[]>;
  busName: string;
  log: Logger;
};

/**
 * Splits entries into PutEvents calls of at most 10, in stream order, never with two events of the
 * same trip in one call: EventBridge may accept later entries of a call after rejecting an earlier
 * one, so this keeps a trip's events from overtaking each other when a call partly fails.
 */
export function chunkEntries(entries: OutboxEntry[]): OutboxEntry[][] {
  const chunks: OutboxEntry[][] = [];
  let current: OutboxEntry[] = [];
  let trips = new Set<string>();
  for (const entry of entries) {
    if (current.length === PUT_EVENTS_MAX || trips.has(entry.tripId)) {
      chunks.push(current);
      current = [];
      trips = new Set();
    }
    current.push(entry);
    trips.add(entry.tripId);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Stream handler: publishes outbox events in calls built by `chunkEntries`, in order. On the first rejected entry it
 * stops and reports that record, so the stream retries from it (later records are re-sent too;
 * consumers tolerate duplicates). A failed PutEvents call rethrows and the whole batch is retried.
 */
export function createPublisher(deps: PublisherDeps): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  return async (event) => {
    for (const chunk of chunkEntries(outboxEntries(event.Records, deps.busName))) {
      const results = await deps.send(chunk.map((e) => e.entry));
      for (const [i, item] of chunk.entries()) {
        const result = results[i];
        if (result === undefined || result.ErrorCode !== undefined) {
          deps.log({
            level: 'error',
            msg: 'event not published',
            detailType: item.entry.DetailType,
            correlationId: item.correlationId,
            errorCode: result?.ErrorCode ?? 'MISSING_RESULT',
          });
          return { batchItemFailures: [{ itemIdentifier: item.sequenceNumber }] };
        }
        deps.log({ level: 'info', msg: 'event published', detailType: item.entry.DetailType, correlationId: item.correlationId });
      }
    }
    return { batchItemFailures: [] };
  };
}

let lambda: ((event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/publisher.mjs`). */
export const handler = (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  if (lambda === undefined) {
    const client = new EventBridgeClient({});
    lambda = createPublisher({
      send: async (entries) => (await client.send(new PutEventsCommand({ Entries: entries }))).Entries ?? [],
      busName: process.env.RIDECORE_EVENT_BUS ?? EVENT_BUS_NAME,
      log: jsonLog,
    });
  }
  return lambda(event);
};
