import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DomainError } from '../../domain/errors.ts';
import type { TripEvent } from '../../domain/events.ts';
import type { Trip } from '../../domain/trip.ts';
import {
  GSI1,
  KEY_ATTRIBUTES,
  outboxKey,
  passengerGsi1Pk,
  type ReservationKind,
  reservationKey,
  tripGsi1,
  tripKey,
} from './keys.ts';

/** One DocumentClient-style item of a `TransactWriteItems` call. */
export type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * What a failed condition on an item means for the caller. When several conditions fail in the
 * same transaction, the lowest `priority` wins (a stale trip version explains everything else).
 */
type Conflict = { code: string; message: string; priority: number };

const CONFLICTS = {
  staleVersion: { code: 'CONCURRENT_UPDATE', message: 'The trip was modified concurrently', priority: 0 },
  activeTrip: { code: 'ACTIVE_TRIP_EXISTS', message: 'The passenger already has an active trip', priority: 1 },
  driverBusy: { code: 'DRIVER_BUSY', message: 'The driver already has an active trip', priority: 2 },
  tripExists: { code: 'TRIP_ALREADY_EXISTS', message: 'A trip with this id already exists', priority: 3 },
  other: { code: 'CONCURRENT_UPDATE', message: 'The trip was modified concurrently', priority: 9 },
} satisfies Record<string, Conflict>;

type TaggedItem = { item: TransactWriteItem; conflict: Conflict };

export class TripRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  /** Persists a new trip, reserves the passenger's single active-trip slot and writes the outbox event, atomically. */
  async create(trip: Trip, event: TripEvent): Promise<void> {
    await this.transact([
      {
        item: { Put: { TableName: this.tableName, Item: this.tripItem(trip), ConditionExpression: 'attribute_not_exists(PK)' } },
        conflict: CONFLICTS.tripExists,
      },
      {
        item: this.putReservation('PASSENGER', trip.passengerId, trip.id),
        conflict: CONFLICTS.activeTrip,
      },
      { item: this.putOutbox(event), conflict: CONFLICTS.other },
    ]);
  }

  /** The transaction items `save` sends for a transition, so callers can compose them with their own items. */
  buildSaveItems(before: Trip, after: Trip, event: TripEvent): TransactWriteItem[] {
    return this.saveItems(before, after, event).map((t) => t.item);
  }

  /**
   * Persists a transition in ONE transaction: the trip (optimistic lock on `before.version`), the
   * outbox event, reservation changes, plus any `extraItems`. DynamoDB rejects a transaction that
   * touches the same item twice, so extra items must not target the trip, its outbox or its reservations.
   */
  async save(before: Trip, after: Trip, event: TripEvent, extraItems: TransactWriteItem[] = []): Promise<void> {
    await this.transact([
      ...this.saveItems(before, after, event),
      ...extraItems.map((item) => ({ item, conflict: CONFLICTS.other })),
    ]);
  }

  async get(id: string): Promise<Trip | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: tripKey(id), ConsistentRead: true }));
    return res.Item ? toTrip(res.Item) : null;
  }

  /** The passenger's trips, newest first. */
  async history(passengerId: string, limit = 20): Promise<Trip[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': GSI1.partitionKey },
        ExpressionAttributeValues: { ':pk': passengerGsi1Pk(passengerId) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).map(toTrip);
  }

  async activeTripId(kind: ReservationKind, id: string): Promise<string | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: reservationKey(kind, id), ConsistentRead: true }),
    );
    const tripId = res.Item?.tripId;
    return typeof tripId === 'string' ? tripId : null;
  }

  private saveItems(before: Trip, after: Trip, event: TripEvent): TaggedItem[] {
    if (before.id !== after.id) throw new Error('save: before and after must be the same trip');
    const items: TaggedItem[] = [
      {
        item: {
          Put: {
            TableName: this.tableName,
            Item: this.tripItem(after),
            ConditionExpression: '#version = :expected',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':expected': before.version },
          },
        },
        conflict: CONFLICTS.staleVersion,
      },
      { item: this.putOutbox(event), conflict: CONFLICTS.other },
    ];

    if (after.state === 'ACCEPTED' && after.driverId !== undefined) {
      items.push({ item: this.putReservation('DRIVER', after.driverId, after.id), conflict: CONFLICTS.driverBusy });
    }
    if (after.state === 'COMPLETED' || after.state === 'CANCELLED') {
      items.push({ item: this.deleteReservation('PASSENGER', after.passengerId, after.id), conflict: CONFLICTS.other });
      // A conditional delete fails on a missing item, so only release a driver slot that was taken.
      if (after.driverId !== undefined) {
        items.push({ item: this.deleteReservation('DRIVER', after.driverId, after.id), conflict: CONFLICTS.other });
      }
    }
    return items;
  }

  private tripItem(trip: Trip): Record<string, unknown> {
    return { ...trip, ...tripKey(trip.id), ...tripGsi1(trip.passengerId, trip.createdAt, trip.id), entity: 'TRIP' };
  }

  private putOutbox(event: TripEvent): TransactWriteItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: { ...event, ...outboxKey(event.tripId, event.version), entity: 'EVENT' },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }

  private putReservation(kind: ReservationKind, id: string, tripId: string): TransactWriteItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: { ...reservationKey(kind, id), tripId, entity: 'RESERVATION' },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    };
  }

  private deleteReservation(kind: ReservationKind, id: string, tripId: string): TransactWriteItem {
    return {
      Delete: {
        TableName: this.tableName,
        Key: reservationKey(kind, id),
        ConditionExpression: 'tripId = :tripId',
        ExpressionAttributeValues: { ':tripId': tripId },
      },
    };
  }

  private async transact(items: TaggedItem[]): Promise<void> {
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items.map((t) => t.item) }));
    } catch (err) {
      throw toDomainError(err, items) ?? err;
    }
  }
}

/**
 * Maps a cancelled transaction to a 409. `CancellationReasons[i]` describes `TransactItems[i]`;
 * the failed item with the lowest priority decides the code. A `TransactionConflict` (another
 * transaction was writing the same item) is reported as a concurrent update.
 */
function toDomainError(err: unknown, items: TaggedItem[]): DomainError | null {
  if (!(err instanceof TransactionCanceledException)) return null;
  const reasons = err.CancellationReasons ?? [];
  let winner: Conflict | null = null;
  for (const [i, reason] of reasons.entries()) {
    const tagged = items[i];
    if (reason.Code === 'ConditionalCheckFailed' && tagged && (!winner || tagged.conflict.priority < winner.priority)) {
      winner = tagged.conflict;
    }
  }
  const conflict: Conflict | null =
    winner ?? (reasons.some((r) => r.Code === 'TransactionConflict') ? CONFLICTS.staleVersion : null);
  return conflict ? new DomainError(conflict.code, 409, conflict.message) : null;
}

function toTrip(item: Record<string, unknown>): Trip {
  const trip: Record<string, unknown> = { ...item };
  for (const key of KEY_ATTRIBUTES) delete trip[key];
  return trip as unknown as Trip;
}
