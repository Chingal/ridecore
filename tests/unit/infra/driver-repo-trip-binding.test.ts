import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import type { DomainError } from '../../../src/domain/errors.ts';
import type { LatLng } from '../../../src/domain/trip.ts';
import { cellOf, type Driver, DriverRepo } from '../../../src/infra/dynamo/driver-repo.ts';
import { driverGsi2 } from '../../../src/infra/dynamo/keys.ts';
import type { ExtraItem } from '../../../src/infra/dynamo/transact.ts';

const A: LatLng = { lat: 2.4448, lng: -76.6147 };
// In another cell, so storing the position read (A) instead of the one written (B) is caught (C17).
const B: LatLng = { lat: 3.4516, lng: -76.532 };

type Update = {
  Key?: { PK: string; SK: string };
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ReturnValues?: string;
};

type RowOverrides = {
  availability?: Driver['availability'];
  position?: LatLng;
  geohash5?: string;
  tripId?: string;
  tripPosition?: LatLng;
};

/** The stored `DRIVER#d1 / META` row with only the overrides given (and GSI2 keys when AVAILABLE in a cell). */
const driverRow = (o: RowOverrides): Record<string, unknown> => {
  const availability = o.availability ?? 'ON_TRIP';
  return {
    PK: 'DRIVER#d1',
    SK: 'META',
    entity: 'DRIVER',
    id: 'd1',
    name: 'd1',
    vehicle: { plate: 'ABC123', model: 'Logan', category: 'STANDARD' },
    availability,
    ...(o.position === undefined ? {} : { position: o.position }),
    ...(o.geohash5 === undefined ? {} : { geohash5: o.geohash5 }),
    ...(availability === 'AVAILABLE' && o.geohash5 !== undefined ? driverGsi2(o.geohash5, 'd1') : {}),
    ...(o.tripId === undefined ? {} : { tripId: o.tripId }),
    ...(o.tripPosition === undefined ? {} : { tripPosition: o.tripPosition }),
  };
};

/** A DynamoDB stub: records the commands and evaluates each write against the stored row (offline). */
function stubRepo(stored: Record<string, unknown>, afterRead: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    sent.push(cmd);
    const key = (cmd as { input: { Key?: Record<string, unknown> } }).input.Key;
    const item = key?.PK === stored.PK && key?.SK === stored.SK ? structuredClone(stored) : undefined;
    Object.assign(stored, afterRead); // a change landing between the first read and the write
    if (cmd instanceof GetCommand) return { Item: item };
    if (cmd instanceof UpdateCommand) {
      const u = cmd.input as Update;
      if (!evalWrite(stored, u).holds) throw new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });
      return u.ReturnValues === 'ALL_NEW' ? { Attributes: structuredClone(stored) } : {};
    }
    if (cmd instanceof TransactWriteCommand) {
      const items = cmd.input.TransactItems ?? [];
      if (!evalWrite(stored, items[0]?.Update as Update).holds) {
        throw new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, ...items.slice(1).map(() => ({ Code: 'None' }))],
        });
      }
      return {};
    }
    throw new Error('unexpected command');
  });
  return { repo: new DriverRepo({ send } as unknown as DynamoDBDocumentClient, 'stub'), sent };
}

const asUpdate = (extra: ExtraItem): Update => (extra as { item: { Update: Update } }).item.Update;
const onFail = (extra: ExtraItem): DomainError => (extra as { onConditionFailed: DomainError }).onConditionFailed;

/**
 * Evaluates a write the way DynamoDB would, so a wrong key, name or value changes the observed result
 * (review-checklist C17): resolves the row by `Key` (another key means no row), checks the condition
 * (`AND` of `attribute_(not_)exists` and `path = :value`, as `holds` does in
 * tests/unit/infra/driver-repo-availability.test.ts) and applies `SET`/`REMOVE`.
 */
function evalWrite(stored: Record<string, unknown>, u: Update): { holds: boolean; after: Record<string, unknown> } {
  const names = u.ExpressionAttributeNames ?? {};
  const values = u.ExpressionAttributeValues ?? {};
  const name = (token: string): string => {
    const key = token.startsWith('#') ? names[token] : token;
    if (key === undefined) throw new Error(`undefined name ${token}`);
    return key;
  };
  const row = u.Key?.PK === stored.PK && u.Key?.SK === stored.SK ? stored : {};
  const resolve = (path: string): unknown =>
    path.split('.').reduce<unknown>((obj, part) => (obj == null ? undefined : (obj as Record<string, unknown>)[name(part)]), row);
  const holds = (u.ConditionExpression ?? '').split(' AND ').every((clause) => {
    const fn = /^attribute_(not_)?exists\((.+)\)$/.exec(clause.trim());
    if (fn) return (resolve(fn[2] as string) === undefined) === (fn[1] !== undefined);
    const [left, right] = clause.split(' = ').map((t) => t.trim());
    if (left === undefined || right === undefined || !(right in values)) throw new Error(`unsupported clause ${clause}`);
    return resolve(left) === values[right];
  });
  const after = structuredClone(row);
  const [setPart = '', removePart = ''] = (u.UpdateExpression ?? '').split('REMOVE');
  for (const clause of setPart.replace(/^\s*SET\s*/, '').split(',').map((c) => c.trim()).filter(Boolean)) {
    const [left, right] = clause.split('=').map((t) => t.trim());
    if (left === undefined || right === undefined || !(right in values)) throw new Error(`unsupported set ${clause}`);
    after[name(left)] = values[right];
  }
  for (const token of removePart.split(',').map((t) => t.trim()).filter(Boolean)) delete after[name(token)];
  return { holds, after };
}

/** The write (Update, or the first Update of a transaction) the repo sent, ignoring the read. */
function writeInput(sent: unknown[]): Update {
  for (const cmd of sent) {
    if (cmd instanceof UpdateCommand) return cmd.input as Update;
    if (cmd instanceof TransactWriteCommand) return (cmd as TransactWriteCommand).input.TransactItems?.[0]?.Update as Update;
  }
  throw new Error('no write command recorded');
}

const captureCommit = () => {
  let view: Driver | undefined;
  const commit = (v: Driver) => {
    view = v;
    return { Put: { TableName: 'stub', Item: { PK: 'IDEM#test', SK: 'META', body: v } } };
  };
  return { commit, seen: () => view };
};

describe('DriverRepo trip binding', () => {
  // Criterion 1.
  it.each([
    { availability: 'AVAILABLE' as const, ok: true },
    { availability: 'ON_TRIP' as const, ok: false },
    { availability: 'OFFLINE' as const, ok: false },
  ])('accept stores the trip id and clears the trip position', ({ availability, ok }) => {
    // A stale trip binding and the sparse index keys are present, so clearing them is observed.
    const row = driverRow({ availability, position: A, geohash5: cellOf(A), tripId: 'old', tripPosition: A });
    const { repo } = stubRepo(row);
    const extra = repo.takeTripItem('d1', 't1');
    const u = asUpdate(extra);
    const { holds: ok2, after } = evalWrite(row, u);

    expect(u.ConditionExpression).toBe('#availability = :available');
    expect(onFail(extra).code).toBe('DRIVER_NOT_AVAILABLE');
    expect(onFail(extra).status).toBe(409);
    // Today's AVAILABLE condition is kept: it holds only for an AVAILABLE driver.
    expect(ok2).toBe(ok);
    if (ok) {
      // The accepted trip is named, the index keys and the (now stale) trip position are cleared.
      expect(after.availability).toBe('ON_TRIP');
      expect(after.tripId).toBe('t1');
      expect(after.tripPosition).toBeUndefined();
      expect(after.GSI2PK).toBeUndefined();
      expect(after.GSI2SK).toBeUndefined();
    }
  });

  // Criterion 2 (driver with a cell and without one).
  it.each([
    { label: 'with a cell', geohash5: cellOf(A) as string | undefined },
    { label: 'without a cell', geohash5: undefined },
  ])('release requires the same trip and clears the binding', async ({ geohash5 }) => {
    const stored = driverRow({ availability: 'ON_TRIP', tripId: 't1', position: A, geohash5, tripPosition: A });
    const { repo } = stubRepo(stored);
    const [extra] = await repo.releaseItems('d1', 't1');
    const u = asUpdate(extra as ExtraItem);
    const { holds: ok, after } = evalWrite(stored, u);

    // The exact condition: the same trip and the cell read (a driver moved since then fails it).
    const cell = geohash5 === undefined ? 'attribute_not_exists(geohash5)' : 'geohash5 = :gh';
    expect(u.ConditionExpression).toBe(`attribute_exists(PK) AND tripId = :tripId AND ${cell}`);
    expect(u.ExpressionAttributeValues).toMatchObject({ ':tripId': 't1', ...(geohash5 === undefined ? {} : { ':gh': geohash5 }) });
    expect(evalWrite({ ...stored, geohash5: cellOf(B) }, u).holds).toBe(false);
    expect(ok).toBe(true);
    expect(after.availability).toBe('AVAILABLE');
    expect(after.tripId).toBeUndefined();
    expect(after.tripPosition).toBeUndefined();
    if (geohash5 === undefined) expect(after.GSI2PK).toBeUndefined();
    else {
      // Back in the availability index under its own cell (not the trip's id).
      expect(after.GSI2PK).toBe(driverGsi2(geohash5, 'd1').GSI2PK);
      expect(after.GSI2SK).toBe(driverGsi2(geohash5, 'd1').GSI2SK);
    }
  });

  // Criterion 3 (another trip, no trip id, the same trip; each with a cell and without one).
  it.each(
    [cellOf(A), undefined].flatMap((geohash5) => [
      { geohash5, tripId: 'other' as string | undefined, ok: false },
      { geohash5, tripId: undefined, ok: false },
      { geohash5, tripId: 't1', ok: true },
    ]),
  )('a release of another trip is a 409 CONCURRENT_UPDATE', async ({ geohash5, tripId, ok }) => {
    const stored = driverRow({ availability: 'ON_TRIP', geohash5, tripId });
    const { repo } = stubRepo(stored);
    const [extra] = await repo.releaseItems('d1', 't1');
    const u = asUpdate(extra as ExtraItem);

    expect(evalWrite(stored, u).holds).toBe(ok);
    expect(onFail(extra as ExtraItem).code).toBe('CONCURRENT_UPDATE');
    expect(onFail(extra as ExtraItem).status).toBe(409);
  });

  // Criterion 4 (ON_TRIP with and without commit, AVAILABLE, OFFLINE).
  it.each([
    { availability: 'ON_TRIP' as const, withCommit: false, tripPos: true },
    { availability: 'ON_TRIP' as const, withCommit: true, tripPos: true },
    { availability: 'AVAILABLE' as const, withCommit: false, tripPos: false },
    { availability: 'AVAILABLE' as const, withCommit: true, tripPos: false },
    { availability: 'OFFLINE' as const, withCommit: false, tripPos: false },
    { availability: 'OFFLINE' as const, withCommit: true, tripPos: false },
  ])('a position written on a trip is also stored as the trip position', async ({ availability, withCommit, tripPos }) => {
    const stored = driverRow({ availability, position: A, geohash5: cellOf(A), ...(tripPos ? { tripId: 't1' } : {}) });
    const { repo, sent } = stubRepo(stored);
    const { commit, seen } = captureCommit();
    const result = await repo.setPosition('d1', B, withCommit ? commit : undefined);
    const { holds: ok, after } = evalWrite(stored, writeInput(sent));
    for (const view of withCommit ? [result, seen()] : [result]) expect(view).toMatchObject({ position: B, geohash5: cellOf(B) });
    expect(ok).toBe(true);
    // With `commit` the write is one transaction (with the commit item) and no standalone update.
    const writes = sent.filter((c) => !(c instanceof GetCommand));
    expect(writes.map((c) => c instanceof TransactWriteCommand)).toEqual([withCommit]);
    expect(seen() !== undefined).toBe(withCommit);
    if (withCommit) expect((writes[0] as TransactWriteCommand).input.TransactItems?.[1]?.Put?.Item?.body).toEqual(seen());
    // Still conditioned on the availability read (an accept or release in between fails it).
    const other = availability === 'AVAILABLE' ? 'ON_TRIP' : 'AVAILABLE';
    expect(evalWrite({ ...stored, availability: other }, writeInput(sent)).holds).toBe(false);

    // position and geohash5 land on B (the written point), not the one read (A).
    expect(after.position).toEqual(B);
    expect(after.geohash5).toBe(cellOf(B));
    if (availability === 'AVAILABLE') {
      expect(after.GSI2PK).toBe(driverGsi2(cellOf(B), 'd1').GSI2PK);
      expect(after.GSI2SK).toBe(driverGsi2(cellOf(B), 'd1').GSI2SK);
    } else {
      expect(after.GSI2PK).toBeUndefined();
      expect(after.GSI2SK).toBeUndefined();
    }
    if (tripPos) expect(after.tripPosition).toEqual(B);
    else expect(after.tripPosition).toBeUndefined();
    expect(after.tripId).toBe(stored.tripId);
    // Only while the trip read is the stored one: trip t1 released and t2 accepted in between fails it.
    if (tripPos) expect(evalWrite({ ...stored, tripId: 't2' }, writeInput(sent)).holds).toBe(false);
    // ...and then re-reads: the retry is bound to t2 instead of failing with 409.
    const race = stubRepo({ ...stored }, { tripId: 't2' });
    if (tripPos) await expect(race.repo.setPosition('d1', B, withCommit ? commit : undefined)).resolves.toMatchObject({ position: B });
  });

  // Criterion 5 (each method and the commit callback; setAvailability without commit returns ALL_NEW).
  it.each([
    { method: 'get' as const, availability: 'ON_TRIP' as const, withCommit: false },
    { method: 'setPosition' as const, availability: 'ON_TRIP' as const, withCommit: false },
    { method: 'setPosition' as const, availability: 'ON_TRIP' as const, withCommit: true },
    { method: 'setAvailability' as const, availability: 'AVAILABLE' as const, withCommit: true },
    { method: 'setAvailability' as const, availability: 'AVAILABLE' as const, withCommit: false },
  ])('the trip binding never leaves the repository', async ({ method, availability, withCommit }) => {
    const { repo } = stubRepo(driverRow({ availability, position: A, geohash5: cellOf(A), tripId: 't1', tripPosition: A }));
    const { commit, seen } = captureCommit();
    const c = withCommit ? commit : undefined;

    let result: Driver | null;
    if (method === 'get') result = await repo.get('d1');
    else if (method === 'setPosition') result = await repo.setPosition('d1', B, c);
    else result = await repo.setAvailability('d1', 'AVAILABLE', c);

    expect(result).not.toHaveProperty('tripId');
    expect(result).not.toHaveProperty('tripPosition');
    if (withCommit) {
      expect(seen()).not.toHaveProperty('tripId');
      expect(seen()).not.toHaveProperty('tripPosition');
    }
  });
});
