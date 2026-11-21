import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { LatLng } from '../../../src/domain/trip.ts';
import { cellOf, type Driver, DriverRepo } from '../../../src/infra/dynamo/driver-repo.ts';

const A: LatLng = { lat: 2.4448, lng: -76.6147 };

type Update = {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ReturnValues?: string;
};

/**
 * Evaluates the subset of DynamoDB condition syntax the repo uses (`AND` of `attribute_exists`,
 * `attribute_not_exists` and `path = :value`, with `#name` placeholders and dotted map paths).
 */
function holds(row: Record<string, unknown>, u: Update): boolean {
  const names = u.ExpressionAttributeNames ?? {};
  const values = u.ExpressionAttributeValues ?? {};
  const resolve = (path: string): unknown =>
    path.split('.').reduce<unknown>((obj, part) => {
      const key = part.startsWith('#') ? names[part] : part;
      if (key === undefined) throw new Error(`undefined name ${part}`);
      return obj === undefined || obj === null ? undefined : (obj as Record<string, unknown>)[key];
    }, row);
  return (u.ConditionExpression ?? '').split(' AND ').every((clause) => {
    const fn = /^attribute_(not_)?exists\((.+)\)$/.exec(clause.trim());
    if (fn) return (resolve(fn[2] as string) === undefined) === (fn[1] !== undefined);
    const [left, right] = clause.split(' = ').map((s) => s.trim());
    if (left === undefined || right === undefined || !(right in values)) throw new Error(`unsupported clause ${clause}`);
    return resolve(left) === values[right];
  });
}

/** Applies the availability/position part of the SET clause to the stored row. */
function apply(row: Driver, u: Update): void {
  const v = u.ExpressionAttributeValues ?? {};
  row.availability = v[':availability'] as Driver['availability'];
  if (':position' in v) {
    row.position = v[':position'] as LatLng;
    row.geohash5 = v[':newGh'] as string;
  }
}

/**
 * A stub table holding one driver. Before every write, `move` may run a concurrent `PUT /position`
 * on the stored row; the write is then checked against its real ConditionExpression.
 */
function stubTable(stored: Driver, move: (row: Driver, write: number) => void) {
  let writes = 0;
  const transactions: unknown[][] = [];
  const row = () => ({ PK: `DRIVER#${stored.id}`, SK: 'META', ...stored });
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand) return { Item: structuredClone(row()) };
    if (cmd instanceof UpdateCommand) {
      move(stored, writes++);
      const u = cmd.input as Update;
      if (!holds(row(), u)) throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
      apply(stored, u);
      return u.ReturnValues === 'ALL_NEW' ? { Attributes: structuredClone(row()) } : {};
    }
    if (cmd instanceof TransactWriteCommand) {
      move(stored, writes++);
      const items = cmd.input.TransactItems ?? [];
      const u = items[0]?.Update as Update;
      if (!holds(row(), u)) {
        throw new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, ...items.slice(1).map(() => ({ Code: 'None' }))],
        });
      }
      apply(stored, u);
      transactions.push(items);
      return {};
    }
    throw new Error('unexpected command');
  });
  return { repo: new DriverRepo({ send } as unknown as DynamoDBDocumentClient, 'stub'), transactions };
}

const offline = (): Driver => ({
  id: 'd1',
  name: 'd1',
  vehicle: { plate: 'ABC123', model: 'Logan', category: 'STANDARD' },
  availability: 'OFFLINE',
  position: A,
  geohash5: cellOf(A),
});

/** Moves the driver north within the same cell before each of the first `times` writes. */
const sameCellMoves =
  (times: number) =>
  (row: Driver, write: number): void => {
    if (write >= times || row.position === undefined) return;
    row.position = { lat: row.position.lat + 0.00001, lng: row.position.lng };
    expect(cellOf(row.position)).toBe(row.geohash5);
  };

describe('DriverRepo.setAvailability racing a position change', () => {
  it('stores and returns the position the transaction left, not the one read before it', async () => {
    const stored = offline();
    const { repo, transactions } = stubTable(stored, sameCellMoves(1));
    const commit = (view: Driver) => ({ Put: { TableName: 'stub', Item: { PK: 'IDEM#test', SK: 'META', body: view } } });

    const result = await repo.setAvailability('d1', 'AVAILABLE', commit);

    expect(stored.position).not.toEqual(A);
    expect(stored).toMatchObject({ availability: 'AVAILABLE' });
    expect(result.position).toEqual(stored.position);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.[1]).toEqual({
      Put: { TableName: 'stub', Item: { PK: 'IDEM#test', SK: 'META', body: expect.objectContaining({ availability: 'AVAILABLE', position: stored.position }) } },
    });
  });

  it('without an Idempotency-Key, succeeds with the current position however often it moves in the cell', async () => {
    const stored = offline();
    const { repo } = stubTable(stored, sameCellMoves(Number.POSITIVE_INFINITY));

    const result = await repo.setAvailability('d1', 'AVAILABLE');

    expect(stored.availability).toBe('AVAILABLE');
    expect(result).toMatchObject({ availability: 'AVAILABLE', position: stored.position });
  });
});
