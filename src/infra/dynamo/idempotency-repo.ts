import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/errors.ts';
import { idempotencyKey } from './keys.ts';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export type IdempotentResult<T> = { status: number; body: T; replayed: boolean };

/** Canonical JSON: object keys sorted recursively, so key order does not change the hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 hex of `METHOD path canonical(body)`, for the `requestHash` argument of `IdempotencyRepo.run`. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()}\n${path}\n${canonical(body)}`).digest('hex');
}

/**
 * Idempotency-Key store (`IDEM#<actorId>#<key>/META`, TTL 24 h). The first request claims the key
 * with a conditional put, so concurrent duplicates cannot both run `fn`; the response is stored
 * when `fn` finishes and replayed for later requests with the same hash.
 */
export class IdempotencyRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  async run<T>(
    actorId: string,
    key: string,
    requestHash: string,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const Key = idempotencyKey(actorId, key);
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...Key,
            entity: 'IDEMPOTENCY',
            requestHash,
            createdAt: new Date().toISOString(),
            expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      return this.existing<T>(Key, requestHash);
    }

    let result: { status: number; body: T };
    try {
      result = await fn();
    } catch (err) {
      // Free the key so the client can retry; a failed cleanup must not mask the original error.
      await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key })).catch(() => undefined);
      throw err;
    }
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key,
        UpdateExpression: 'SET #response = :response',
        ExpressionAttributeNames: { '#response': 'response' },
        ExpressionAttributeValues: { ':response': { status: result.status, body: result.body } },
      }),
    );
    return { ...result, replayed: false };
  }

  private async existing<T>(Key: { PK: string; SK: string }, requestHash: string): Promise<IdempotentResult<T>> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    const item = res.Item;
    // Item gone between the failed claim and this read (released after a failure, or TTL): the client retries.
    if (item === undefined) throw inProgress();
    if (item.requestHash !== requestHash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 422, 'This Idempotency-Key was used with a different request');
    }
    const response = item.response as { status: number; body: T } | undefined;
    if (response === undefined) throw inProgress();
    return { status: response.status, body: response.body, replayed: true };
  }
}

const inProgress = () => new DomainError('REQUEST_IN_PROGRESS', 409, 'A request with this Idempotency-Key is still in progress');
