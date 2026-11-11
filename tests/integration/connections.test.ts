import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { CONNECTION_TTL_SECONDS, ConnectionRepo } from '../../src/infra/dynamo/connection-repo.ts';
import { connectionKey, throttleKey } from '../../src/infra/dynamo/keys.ts';
import { ThrottleRepo } from '../../src/infra/dynamo/throttle-repo.ts';
import { createTestTable, deleteTestTable, useFlociEnv } from './helpers/table.ts';

useFlociEnv();
const client = createDynamoClient();
const doc = createDocumentClient(client);
let table: string;
let connections: ConnectionRepo;
let throttle: ThrottleRepo;

beforeAll(async () => {
  table = await createTestTable(client, 'connections');
  connections = new ConnectionRepo(doc, table);
  throttle = new ThrottleRepo(doc, table);
});

afterAll(async () => {
  await deleteTestTable(client, table);
});

const NOW = new Date('2026-11-11T12:00:00.000Z');
const id = () => randomUUID().slice(0, 12);

describe('ConnectionRepo', () => {
  it('finds a connection by its actor, with a 2 h 10 min TTL and entity CONNECTION', async () => {
    const connectionId = id();
    const actorId = id();
    await connections.put({ connectionId, actor: { id: actorId, role: 'passenger' }, connectedAt: NOW.toISOString() }, NOW);

    expect(await connections.byActor({ id: actorId, role: 'passenger' })).toEqual([connectionId]);
    const item = (await doc.send(new GetCommand({ TableName: table, Key: connectionKey(connectionId) }))).Item;
    expect(item?.entity).toBe('CONNECTION');
    expect(item?.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + CONNECTION_TTL_SECONDS);
    expect(CONNECTION_TTL_SECONDS).toBe(7800);
  });

  it('keeps a passenger and a driver with the same id apart', async () => {
    const actorId = id();
    const p = id();
    const d = id();
    await connections.put({ connectionId: p, actor: { id: actorId, role: 'passenger' }, connectedAt: NOW.toISOString() }, NOW);
    await connections.put({ connectionId: d, actor: { id: actorId, role: 'driver' }, connectedAt: NOW.toISOString() }, NOW);

    expect(await connections.byActor({ id: actorId, role: 'passenger' })).toEqual([p]);
    expect(await connections.byActor({ id: actorId, role: 'driver' })).toEqual([d]);
  });

  it('returns a watcher once across the cells it is asked for, and get() returns the connection', async () => {
    const connectionId = id();
    const actor = { id: id(), role: 'passenger' as const };
    await connections.put({ connectionId, actor, connectedAt: NOW.toISOString() }, NOW);
    await connections.watch(connectionId, 'd29e1');

    expect(await connections.watchersOf(['d29e1', 'd29e1', 'd29e3'])).toEqual([connectionId]);
    expect(await connections.watchersOf(['d29e3'])).toEqual([]);
    expect(await connections.get(connectionId)).toMatchObject({ connectionId, actor, watchCell: 'd29e1' });
  });

  it('remove() empties both lookups; watch() on a removed connection writes nothing', async () => {
    const connectionId = id();
    const actor = { id: id(), role: 'passenger' as const };
    await connections.put({ connectionId, actor, connectedAt: NOW.toISOString() }, NOW);
    await connections.watch(connectionId, 'd29e4');
    await connections.remove(connectionId);

    expect(await connections.byActor(actor)).toEqual([]);
    expect(await connections.watchersOf(['d29e4'])).toEqual([]);
    expect(await connections.get(connectionId)).toBeNull();

    await connections.watch(connectionId, 'd29e4');
    expect(await connections.get(connectionId)).toBeNull();
  });
});

describe('ThrottleRepo', () => {
  it('lets one call through per window and never writes a DRIVER item', async () => {
    const driverId = id();
    expect(await throttle.once('position', driverId, NOW, 3000)).toBe(true);
    expect(await throttle.once('position', driverId, new Date(NOW.getTime() + 2999), 3000)).toBe(false);
    expect(await throttle.once('position', driverId, new Date(NOW.getTime() + 3001), 3000)).toBe(true);
    expect(await throttle.once('position', id(), NOW, 3000)).toBe(true);

    const item = (await doc.send(new GetCommand({ TableName: table, Key: throttleKey('position', driverId) }))).Item;
    expect(item?.entity).toBe('THROTTLE');
    expect(item?.PK).not.toMatch(/^DRIVER#/);
  });
});
