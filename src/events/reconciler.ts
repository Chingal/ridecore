import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { createDocumentClient, createDynamoClient } from '../infra/dynamo/client.ts';
import { OUTBOX_SHARDS, outboxPendingGsi2 } from '../infra/dynamo/keys.ts';
import { createOutboxStore, type OutboxStore } from '../infra/dynamo/outbox-store.ts';
import { jsonLog, type Logger } from '../log.ts';
import { EVENT_BUS_NAME } from './names.ts';
import { type BuiltEntry, buildEntry } from './outbox-entry.ts';
import { chunkEntries, type PublisherDeps } from './publisher.ts';

export type ReconcileSummary = { found: number; published: number; failed: number; oldestAgeSeconds: number };

export type ReconcilerDeps = {
  store: Pick<OutboxStore, 'pending' | 'clear' | 'defer'>;
  send: PublisherDeps['send'];
  busName: string;
  log: Logger;
  now: () => Date;
  /** Only events pending longer than this are taken: younger ones are still on their way through the stream. */
  ageSeconds?: number;
  /** Upper bound of events per run, split evenly between the shards. */
  maxPerRun?: number;
};

type Pending = BuiltEntry & { version: number; occurredAt: string };

/**
 * The outbox safety net (ADR 0008, change 2). Every run reads each shard of the pending index for
 * events older than `ageSeconds`, publishes them with the publisher's chunking rules, clears the
 * accepted ones and moves the rejected ones to the back of their shard. Shards are independent: a
 * shard that fails is logged and the run moves on, and the starting shard rotates every minute.
 */
export function createReconciler(deps: ReconcilerDeps): () => Promise<ReconcileSummary> {
  const ageSeconds = deps.ageSeconds ?? 60;
  const perShard = Math.max(1, Math.floor((deps.maxPerRun ?? 500) / OUTBOX_SHARDS));

  return async () => {
    const now = deps.now();
    const nowIso = now.toISOString();
    const cut = new Date(now.getTime() - ageSeconds * 1000).toISOString();
    const summary: ReconcileSummary = { found: 0, published: 0, failed: 0, oldestAgeSeconds: 0 };
    let oldest: string | undefined;
    const first = now.getUTCMinutes() % OUTBOX_SHARDS;

    for (let i = 0; i < OUTBOX_SHARDS; i++) {
      const shard = (first + i) % OUTBOX_SHARDS;
      let pending: Pending[];
      try {
        const items = await deps.store.pending(shard, cut, perShard);
        pending = items.map((item) => ({ ...buildEntry(item, deps.busName), version: Number(item.version), occurredAt: String(item.occurredAt) }));
      } catch (err) {
        deps.log({ level: 'error', msg: 'outbox shard failed', shard, error: (err as Error).message });
        continue;
      }
      summary.found += pending.length;
      for (const p of pending) if (oldest === undefined || p.occurredAt < oldest) oldest = p.occurredAt;

      for (const chunk of chunkEntries(pending)) {
        let results;
        try {
          results = await deps.send(chunk.map((p) => p.entry));
        } catch (err) {
          deps.log({ level: 'error', msg: 'outbox shard failed', shard, error: (err as Error).message });
          summary.failed += chunk.length;
          continue;
        }
        for (const [j, p] of chunk.entries()) {
          const result = results[j];
          if (result === undefined || result.ErrorCode !== undefined) {
            summary.failed += 1;
            deps.log({ level: 'error', msg: 'event not published', detailType: p.entry.DetailType, correlationId: p.correlationId, errorCode: result?.ErrorCode ?? 'MISSING_RESULT' });
            await settle(deps, p, 'outbox marker not deferred', () => deps.store.defer(p.key, outboxPendingGsi2(p.tripId, nowIso, p.version).GSI2SK));
            continue;
          }
          summary.published += 1;
          await settle(deps, p, 'outbox marker not cleared', () => deps.store.clear(p.key, nowIso));
        }
      }
    }

    if (oldest !== undefined) summary.oldestAgeSeconds = Math.round((now.getTime() - Date.parse(oldest)) / 1000);
    deps.log({ level: 'info', msg: 'outbox reconciled', ...summary });
    return summary;
  };
}

/** A marker write that fails only means the event is looked at again next run: log it, never throw. */
async function settle(deps: ReconcilerDeps, p: Pending, msg: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    deps.log({ level: 'warn', msg, correlationId: p.correlationId, error: (err as Error).message });
  }
}

let lambda: (() => Promise<ReconcileSummary>) | undefined;

/** Lambda entry point (bundled to `dist/reconciler.mjs`), run every minute by a schedule. */
export const handler = (): Promise<ReconcileSummary> => {
  if (lambda === undefined) {
    const table = process.env.RIDECORE_TABLE;
    if (!table) throw new Error('RIDECORE_TABLE is not set');
    const client = new EventBridgeClient({});
    lambda = createReconciler({
      store: createOutboxStore(createDocumentClient(createDynamoClient()), table),
      send: async (entries) => (await client.send(new PutEventsCommand({ Entries: entries }))).Entries ?? [],
      busName: process.env.RIDECORE_EVENT_BUS ?? EVENT_BUS_NAME,
      log: jsonLog,
      now: () => new Date(),
    });
  }
  return lambda();
};
