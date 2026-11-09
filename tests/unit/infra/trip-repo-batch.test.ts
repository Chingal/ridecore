import type { BatchGetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { TripRepo } from '../../../src/infra/dynamo/trip-repo.ts';

type Key = { PK: string; SK: string };

/** Stub BatchGetItem: records each request's key count; the first call leaves its last key unprocessed. */
function batchRepo(): { repo: TripRepo; sizes: number[] } {
  const sizes: number[] = [];
  const send = (cmd: BatchGetCommand) => {
    const keys = (cmd.input.RequestItems?.stub?.Keys ?? []) as Key[];
    sizes.push(keys.length);
    const served = sizes.length === 1 ? keys.slice(0, -1) : keys;
    const unprocessed = sizes.length === 1 ? keys.slice(-1) : [];
    return Promise.resolve({
      Responses: { stub: served.filter((k) => k.PK !== 'TRIP#missing').map((k) => ({ ...k, id: k.PK.slice('TRIP#'.length), state: 'REQUESTED' })) },
      UnprocessedKeys: unprocessed.length > 0 ? { stub: { Keys: unprocessed } } : {},
    });
  };
  return { repo: new TripRepo({ send } as unknown as DynamoDBDocumentClient, 'stub'), sizes };
}

describe('TripRepo.getMany', () => {
  it('reads in BatchGetItem chunks of 100, retries unprocessed keys, skips missing trips and keeps the input order', async () => {
    const { repo, sizes } = batchRepo();
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const trips = await repo.getMany([...ids, 'missing']);
    expect(sizes).toEqual([100, 1, 51]); // chunk 1, its unprocessed key retried, chunk 2
    expect(trips.map((t) => t.id)).toEqual(ids);
  });

  it('returns [] without calling DynamoDB for no ids', async () => {
    const { repo, sizes } = batchRepo();
    expect(await repo.getMany([])).toEqual([]);
    expect(sizes).toEqual([]);
  });
});
