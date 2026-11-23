import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { LatLng } from '../../../src/domain/trip.ts';
import { cellOf, type Driver, DriverRepo, MAX_QUERY_ITEMS, MAX_QUERY_PAGES } from '../../../src/infra/dynamo/driver-repo.ts';

const CENTER: LatLng = { lat: 2.4448, lng: -76.6147 };

const driver = (id: string, kmNorth: number): Driver => {
  const position = { lat: CENTER.lat + kmNorth / 111.2, lng: CENTER.lng };
  return {
    id,
    name: id,
    vehicle: { plate: 'ABC123', model: 'Logan', category: 'STANDARD' },
    availability: 'AVAILABLE',
    position,
    geohash5: cellOf(position),
  };
};

/** A stub client whose GSI2 query for the centre cell answers in two pages, the nearest driver on page 2. */
function pagedRepo(): { repo: DriverRepo; startKeys: unknown[] } {
  const startKeys: unknown[] = [];
  const centerPk = `AVAIL#${cellOf(CENTER)}`;
  const send = (cmd: QueryCommand) => {
    const { ExpressionAttributeValues, ExclusiveStartKey } = cmd.input;
    if (ExpressionAttributeValues?.[':pk'] !== centerPk) return Promise.resolve({ Items: [] });
    startKeys.push(ExclusiveStartKey);
    return Promise.resolve(
      ExclusiveStartKey === undefined
        ? { Items: [driver('far', 2), driver('mid', 1)], LastEvaluatedKey: { PK: 'DRIVER#mid', SK: 'META' } }
        : { Items: [driver('nearest', 0.1)] },
    );
  };
  const doc = { send } as unknown as DynamoDBDocumentClient;
  return { repo: new DriverRepo(doc, 'stub'), startKeys };
}

describe('DriverRepo.availableNear pagination', () => {
  it('reads every page of a cell before ranking, so the nearest driver on page 2 comes first', async () => {
    const { repo, startKeys } = pagedRepo();
    const near = await repo.availableNear(CENTER, 2);
    expect(near.map((d) => d.id)).toEqual(['nearest', 'mid']);
    expect(startKeys).toEqual([undefined, { PK: 'DRIVER#mid', SK: 'META' }]);
  });

  it('returns a driver once when a neighbour cell repeats', async () => {
    const position = { lat: 90, lng: 0 };
    const geohash5 = cellOf(position);
    const d = { ...driver('d1', 0), position, geohash5 };
    const doc = {
      send: async (cmd: QueryCommand) => ({
        Items: cmd.input.ExpressionAttributeValues?.[':pk'] === `AVAIL#${geohash5}` ? [d] : [],
      }),
    } as unknown as DynamoDBDocumentClient;
    const nearby = await new DriverRepo(doc, 'stub').availableNear(position, 5);
    expect(nearby.map((x) => x.id)).toEqual(['d1']);
  });

  it('keeps only the nearest copy of a driver read from two cells', async () => {
    const centerPk = `AVAIL#${cellOf(CENTER)}`;
    const stale = driver('d1', 3);
    const fresh = driver('d1', 0.1);
    // The farther copy comes from the centre cell, which is read first, so keeping the first copy seen fails.
    const doc = {
      send: async (cmd: QueryCommand) => ({
        Items: cmd.input.ExpressionAttributeValues?.[':pk'] === centerPk ? [stale, driver('d2', 1)] : [fresh],
      }),
    } as unknown as DynamoDBDocumentClient;
    const nearby = await new DriverRepo(doc, 'stub').availableNear(CENTER, 5);
    expect(nearby.map((x) => x.id)).toEqual(['d1', 'd2']);
    expect(nearby[0]?.position).toEqual(fresh.position);
  });

  it('refuses to read past the page cap instead of truncating silently', async () => {
    let calls = 0;
    const send = () => {
      calls++;
      return Promise.resolve({ Items: [driver(`d${calls}`, 1)], LastEvaluatedKey: { PK: `DRIVER#d${calls}`, SK: 'META' } });
    };
    const repo = new DriverRepo({ send } as unknown as DynamoDBDocumentClient, 'stub');
    await expect(repo.offeredTripIds('d1')).rejects.toThrow(/query cap/);
    expect(calls).toBe(MAX_QUERY_PAGES);
  });

  it('refuses a result larger than the item cap', async () => {
    const big = Array.from({ length: MAX_QUERY_ITEMS + 1 }, (_, i) => ({ tripId: `t${i}` }));
    const send = () => Promise.resolve({ Items: big });
    const repo = new DriverRepo({ send } as unknown as DynamoDBDocumentClient, 'stub');
    await expect(repo.offeredTripIds('d1')).rejects.toThrow(/query cap/);
  });
});
