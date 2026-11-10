import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DomainError } from '../../domain/errors.ts';

/** One DocumentClient-style item of a `TransactWriteItems` call. */
export type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * An extra item for a repository transaction: either a bare transaction item (a failed condition
 * maps to 409 CONCURRENT_UPDATE) or one tagged with the error to raise when ITS condition fails.
 */
export type ExtraItem = TransactWriteItem | { item: TransactWriteItem; onConditionFailed?: DomainError };

/**
 * What a failed condition on an item means for the caller. When several conditions fail in the
 * same transaction, the lowest `priority` wins.
 */
export type Conflict = { code: string; message: string; priority: number };

/** A transaction item plus the error its failed condition raises. */
export type TaggedItem = { item: TransactWriteItem; priority: number; error: () => DomainError };

export const CONCURRENT_UPDATE: Conflict = { code: 'CONCURRENT_UPDATE', message: 'The trip was modified concurrently', priority: 9 };

/** Tagged extras rank after every repository-level conflict, in the order the caller passed them. */
const TAGGED_EXTRA_PRIORITY = 10;

export const tag = (item: TransactWriteItem, conflict: Conflict): TaggedItem => ({
  item,
  priority: conflict.priority,
  error: () => new DomainError(conflict.code, 409, conflict.message),
});

export function tagExtra(extra: ExtraItem, index: number): TaggedItem {
  if (!('item' in extra)) return tag(extra, CONCURRENT_UPDATE);
  const { item, onConditionFailed } = extra;
  if (onConditionFailed === undefined) return tag(item, CONCURRENT_UPDATE);
  return { item, priority: TAGGED_EXTRA_PRIORITY + index, error: () => onConditionFailed };
}

/** Sends `items` as ONE `TransactWriteItems`; a cancelled transaction becomes the DomainError of its items. */
export async function transact(doc: DynamoDBDocumentClient, items: TaggedItem[]): Promise<void> {
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: items.map((t) => t.item) }));
  } catch (err) {
    throw toDomainError(err, items) ?? err;
  }
}

/**
 * Maps a cancelled transaction to a DomainError. `CancellationReasons[i]` describes `TransactItems[i]`;
 * the failed item with the lowest priority decides the error. A `TransactionConflict` (another
 * transaction was writing the same item) is reported as a concurrent update.
 */
export function toDomainError(err: unknown, items: TaggedItem[]): DomainError | null {
  if (!(err instanceof TransactionCanceledException)) return null;
  const reasons = err.CancellationReasons ?? [];
  let winner: TaggedItem | null = null;
  for (const [i, reason] of reasons.entries()) {
    const tagged = items[i];
    if (reason.Code === 'ConditionalCheckFailed' && tagged && (!winner || tagged.priority < winner.priority)) {
      winner = tagged;
    }
  }
  if (winner) return winner.error();
  return reasons.some((r) => r.Code === 'TransactionConflict')
    ? new DomainError(CONCURRENT_UPDATE.code, 409, CONCURRENT_UPDATE.message)
    : null;
}

/**
 * Builds an extra item from the result of a write, so it commits in the same transaction as that
 * write (the HTTP layer uses it for the Idempotency-Key completion that stores the response).
 */
export type ResultItem<R> = (result: R) => ExtraItem;

/** The extra items for `commit` applied to `result`, or none. */
export const resultItems = <R>(commit: ResultItem<R> | undefined, result: R): ExtraItem[] =>
  commit === undefined ? [] : [commit(result)];
