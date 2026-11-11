import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { throttleKey } from './keys.ts';

const THROTTLE_TTL_SECONDS = 60 * 60;

/** "At most once per window" markers in their own items (never on the item being throttled). */
export class ThrottleRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  /** True for the first call in each `windowMs`; concurrent callers race on one conditional put. */
  async once(scope: string, id: string, now: Date, windowMs: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...throttleKey(scope, id),
            entity: 'THROTTLE',
            at: now.getTime(),
            expiresAt: Math.floor((now.getTime() + windowMs) / 1000) + THROTTLE_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(PK) OR #at <= :cutoff',
          ExpressionAttributeNames: { '#at': 'at' },
          ExpressionAttributeValues: { ':cutoff': now.getTime() - windowMs },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
