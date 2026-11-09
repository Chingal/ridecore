import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { DomainError } from '../../domain/errors.ts';
import { idempotencyKey } from './keys.ts';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** How long a claim without a stored response blocks retries (409) before another request may take it over. */
export const IDEMPOTENCY_LEASE_SECONDS = 30;

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
  private readonly now: () => number;

  /** `now` returns epoch milliseconds; injectable so tests need not sleep. */
  constructor(doc: DynamoDBDocumentClient, tableName: string, now: () => number = Date.now) {
    this.doc = doc;
    this.tableName = tableName;
    this.now = now;
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
            expiresAt: this.nowSeconds() + IDEMPOTENCY_TTL_SECONDS,
            leaseUntil: this.nowSeconds() + IDEMPOTENCY_LEASE_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const taken = await this.existing<T>(Key, requestHash);
      if (taken.replay !== undefined) return taken.replay;
    }
    return this.execute(actorId, key, Key, fn);
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  /** Runs `fn` under a claim this request owns, stores the response, or releases the claim on failure. */
  private async execute<T>(
    actorId: string,
    key: string,
    Key: { PK: string; SK: string },
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    let result: { status: number; body: T };
    try {
      result = await fn();
    } catch (err) {
      // Free the key so the client can retry. A failed cleanup must not mask the original error; it is
      // logged, and the claim's lease expiry lets a later retry take the key over.
      await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key })).catch((cleanupErr: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'idempotency_cleanup_failed',
            actorId,
            key,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          }),
        );
      });
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

  /**
   * The key is already claimed. Returns `{ replay }` for a stored response, `{}` when this request took
   * over an expired lease (same hash, no response) and must run `fn`; otherwise throws 422 / 409.
   */
  private async existing<T>(Key: { PK: string; SK: string }, requestHash: string): Promise<{ replay?: IdempotentResult<T> }> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    const item = res.Item;
    // Item gone between the failed claim and this read (released after a failure, or TTL): the client retries.
    if (item === undefined) throw inProgress();
    if (item.requestHash !== requestHash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 422, 'This Idempotency-Key was used with a different request');
    }
    const response = item.response as { status: number; body: T } | undefined;
    if (response !== undefined) return { replay: { status: response.status, body: response.body, replayed: true } };
    const nowSec = this.nowSeconds();
    if (typeof item.leaseUntil !== 'number' || item.leaseUntil >= nowSec) throw inProgress();
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key,
          UpdateExpression: 'SET leaseUntil = :next',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#response) AND leaseUntil < :now AND requestHash = :hash',
          ExpressionAttributeNames: { '#response': 'response' },
          ExpressionAttributeValues: { ':next': nowSec + IDEMPOTENCY_LEASE_SECONDS, ':now': nowSec, ':hash': requestHash },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw inProgress();
      throw err;
    }
    return {};
  }
}

const inProgress = () => new DomainError('REQUEST_IN_PROGRESS', 409, 'A request with this Idempotency-Key is still in progress');
