import { EventBridgeClient, PutEventsCommand, type PutEventsRequestEntry, type PutEventsResultEntry } from '@aws-sdk/client-eventbridge';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { jsonLog, type Logger } from '../log.ts';
import { EVENT_BUS_NAME } from './names.ts';
import { buildEntry, type BuiltEntry, type OutboxKey } from './outbox-entry.ts';
import { createDocumentClient, createDynamoClient } from '../infra/dynamo/client.ts';
import { createOutboxStore } from '../infra/dynamo/outbox-store.ts';

export { EVENT_SOURCE } from './names.ts';

/** PutEvents accepts at most 10 entries per call. */
const PUT_EVENTS_MAX = 10;

export type OutboxEntry = BuiltEntry & { sequenceNumber: string };

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
    entries.push({ sequenceNumber, ...buildEntry(item, busName) });
  }
  return entries;
}

export type PublisherDeps = {
  send: (entries: PutEventsRequestEntry[]) => Promise<PutEventsResultEntry[]>;
  busName: string;
  log: Logger;
  /** Removes the outbox item's pending marker (ADR 0008, change 2); see `OutboxStore.clear`. */
  clear: (key: OutboxKey, publishedAt: string) => Promise<void>;
  now: () => Date;
};

/**
 * Splits entries into PutEvents calls of at most 10, in stream order, never with two events of the
 * same trip in one call: EventBridge may accept later entries of a call after rejecting an earlier
 * one, so this keeps a trip's events from overtaking each other when a call partly fails.
 */
export function chunkEntries<T extends { tripId: string }>(entries: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
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
 * After an entry is accepted its pending marker is cleared; a failed clear is only logged.
 */
export function createPublisher(deps: PublisherDeps): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  return async (event) => {
    for (const chunk of chunkEntries(outboxEntries(event.Records, deps.busName))) {
      const results = await deps.send(chunk.map((e) => e.entry));
      const accepted: OutboxEntry[] = [];
      let rejected: OutboxEntry | undefined;
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
          rejected = item;
          break;
        }
        deps.log({ level: 'info', msg: 'event published', detailType: item.entry.DetailType, correlationId: item.correlationId });
        accepted.push(item);
      }
      // Clears run side by side: each one only logs on failure, and none may hold the batch up.
      await Promise.all(accepted.map((item) => clearMarker(deps, item)));
      if (rejected !== undefined) return { batchItemFailures: [{ itemIdentifier: rejected.sequenceNumber }] };
    }
    return { batchItemFailures: [] };
  };
}

/**
 * Clears the pending marker of a published event. A failure only means the reconciler publishes the
 * event again later (a duplicate the consumers absorb), so it is logged and never fails the batch.
 */
async function clearMarker(deps: PublisherDeps, item: OutboxEntry): Promise<void> {
  try {
    await deps.clear(item.key, deps.now().toISOString());
  } catch (err) {
    deps.log({ level: 'warn', msg: 'outbox marker not cleared', correlationId: item.correlationId, error: (err as Error).message });
  }
}

function requiredTable(): string {
  const table = process.env.RIDECORE_TABLE;
  if (!table) throw new Error('RIDECORE_TABLE is not set');
  return table;
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
      clear: createOutboxStore(createDocumentClient(createDynamoClient()), requiredTable()).clear,
      now: () => new Date(),
    });
  }
  return lambda(event);
};
