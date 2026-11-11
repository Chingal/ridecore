import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { consumedKey } from './keys.ts';
import type { TransactWriteItem } from './transact.ts';

/** How long a dedup record lives; far longer than any SQS retry or redrive of the same message. */
export const CONSUMED_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Dedup records: "consumer X already applied event Y" (ADR 0004, idempotent consumers). */
export class ConsumedRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  /** The dedup Put for a consumer's own transaction; it fails when the event was already applied. */
  putItem(consumer: string, eventId: string, now: Date): TransactWriteItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          ...consumedKey(consumer, eventId),
          entity: 'CONSUMED',
          consumer,
          eventId,
          expiresAt: Math.floor(now.getTime() / 1000) + CONSUMED_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }

  /** Whether `consumer` already recorded the event (strongly consistent read). */
  async has(consumer: string, eventId: string): Promise<boolean> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: consumedKey(consumer, eventId), ConsistentRead: true }),
    );
    return res.Item !== undefined;
  }

  /** Records the event for `consumer`; false when it was already recorded (a duplicate delivery). */
  async markOnce(consumer: string, eventId: string, now: Date): Promise<boolean> {
    const put = this.putItem(consumer, eventId, now).Put;
    if (put === undefined) throw new Error('unreachable: putItem always builds a Put');
    try {
      await this.doc.send(new PutCommand(put));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
