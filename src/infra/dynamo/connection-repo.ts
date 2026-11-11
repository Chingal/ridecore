import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Actor } from '../../domain/trip.ts';
import { MAX_QUERY_ITEMS, MAX_QUERY_PAGES } from './driver-repo.ts';
import { connectionActorGsi1, connectionKey, GSI1, GSI2, watchCellPk, watchGsi2 } from './keys.ts';

/** API Gateway closes a socket after 2 h; the item outlives it by 10 min, then TTL removes it. */
export const CONNECTION_TTL_SECONDS = 2 * 60 * 60 + 10 * 60;

export type Connection = { connectionId: string; actor: Actor; connectedAt: string; watchCell?: string };

/** One item per open WebSocket (`CONN#<id>/META`), found by actor (GSI1) or by watched map cell (GSI2). */
export class ConnectionRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  async put(c: Connection, now: Date): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...connectionKey(c.connectionId),
          ...connectionActorGsi1(c.actor.role, c.actor.id, c.connectionId),
          entity: 'CONNECTION',
          connectionId: c.connectionId,
          actor: c.actor,
          connectedAt: c.connectedAt,
          expiresAt: Math.floor(now.getTime() / 1000) + CONNECTION_TTL_SECONDS,
        },
      }),
    );
  }

  async get(connectionId: string): Promise<Connection | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: connectionKey(connectionId) }));
    const item = res.Item;
    if (item === undefined) return null;
    return {
      connectionId: item.connectionId as string,
      actor: item.actor as Actor,
      connectedAt: item.connectedAt as string,
      ...(typeof item.watchCell === 'string' ? { watchCell: item.watchCell } : {}),
    };
  }

  async remove(connectionId: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: connectionKey(connectionId) }));
  }

  /** Watches one map cell (replacing the previous one). A connection already gone is left alone. */
  async watch(connectionId: string, cell: string): Promise<void> {
    const keys = watchGsi2(cell, connectionId);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: connectionKey(connectionId),
          UpdateExpression: 'SET watchCell = :cell, GSI2PK = :pk, GSI2SK = :sk',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':cell': cell, ':pk': keys.GSI2PK, ':sk': keys.GSI2SK },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return;
      throw err;
    }
  }

  async byActor(actor: Actor): Promise<string[]> {
    const { GSI1PK } = connectionActorGsi1(actor.role, actor.id, '');
    return this.ids({
      TableName: this.tableName,
      IndexName: GSI1.indexName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': GSI1.partitionKey },
      ExpressionAttributeValues: { ':pk': GSI1PK },
    });
  }

  /** Connections watching any of `cells`, each once. */
  async watchersOf(cells: readonly string[]): Promise<string[]> {
    const found = await Promise.all(
      [...new Set(cells)].map((cell) =>
        this.ids({
          TableName: this.tableName,
          IndexName: GSI2.indexName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': GSI2.partitionKey },
          ExpressionAttributeValues: { ':pk': watchCellPk(cell) },
        }),
      ),
    );
    return [...new Set(found.flat())];
  }

  /** Connection ids of a query, all pages up to the shared caps; beyond them it throws rather than truncate. */
  private async ids(input: QueryCommandInput): Promise<string[]> {
    const ids: string[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      const res = await this.doc.send(
        new QueryCommand({ ...input, ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }) }),
      );
      for (const item of res.Items ?? []) if (typeof item.connectionId === 'string') ids.push(item.connectionId);
      if (ids.length > MAX_QUERY_ITEMS) break;
      startKey = res.LastEvaluatedKey;
      if (startKey === undefined) return ids;
    }
    throw new Error(`ConnectionRepo query cap exceeded (${MAX_QUERY_PAGES} pages / ${MAX_QUERY_ITEMS} items)`);
  }
}
