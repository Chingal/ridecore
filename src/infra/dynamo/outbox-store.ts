import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { OutboxKey } from '../../events/outbox-entry.ts';
import { GSI2, outboxPendingPk } from './keys.ts';

export type OutboxStore = {
  /** Outbox items of `shard` still pending with `GSI2SK < before`, oldest first, at most `limit`. */
  pending(shard: number, before: string, limit: number): Promise<Record<string, unknown>[]>;
  /** Removes the pending marker and stamps `publishedAt`; an item that no longer exists is ignored. */
  clear(key: OutboxKey, publishedAt: string): Promise<void>;
  /** Moves a still-pending item to `gsi2sk` (the back of its shard) and counts the attempt. */
  defer(key: OutboxKey, gsi2sk: string): Promise<void>;
};

/** The pending index of the outbox (ADR 0008, change 2): sparse `OUTBOX#<shard>` keys on GSI2. */
export function createOutboxStore(doc: DynamoDBDocumentClient, table: string): OutboxStore {
  async function ignoringMissing(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  }

  return {
    async pending(shard, before, limit) {
      const found: Record<string, unknown>[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: table,
            IndexName: GSI2.indexName,
            KeyConditionExpression: '#pk = :pk AND #sk < :before',
            ExpressionAttributeNames: { '#pk': GSI2.partitionKey, '#sk': GSI2.sortKey },
            ExpressionAttributeValues: { ':pk': outboxPendingPk(shard), ':before': before },
            ScanIndexForward: true,
            Limit: limit - found.length,
            ...(start === undefined ? {} : { ExclusiveStartKey: start }),
          }),
        );
        found.push(...(res.Items ?? []));
        start = res.LastEvaluatedKey;
      } while (start !== undefined && found.length < limit);
      return found.slice(0, limit);
    },

    clear: (key, publishedAt) =>
      ignoringMissing(() =>
        doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: 'REMOVE #pk, #sk SET publishedAt = :at',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeNames: { '#pk': GSI2.partitionKey, '#sk': GSI2.sortKey },
            ExpressionAttributeValues: { ':at': publishedAt },
          }),
        ),
      ),

    defer: (key, gsi2sk) =>
      ignoringMissing(() =>
        doc.send(
          new UpdateCommand({
            TableName: table,
            Key: key,
            UpdateExpression: 'SET #sk = :sk ADD outboxAttempts :one',
            ConditionExpression: 'attribute_exists(#pk)',
            ExpressionAttributeNames: { '#pk': GSI2.partitionKey, '#sk': GSI2.sortKey },
            ExpressionAttributeValues: { ':sk': gsi2sk, ':one': 1 },
          }),
        ),
      ),
  };
}
