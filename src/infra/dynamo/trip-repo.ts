import { currentCorrelationId } from '../../context.ts';
import { BatchGetCommand, type DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { TripEvent } from '../../domain/events.ts';
import type { Trip } from '../../domain/trip.ts';
import {
  GSI1,
  KEY_ATTRIBUTES,
  OFFER_SEQ,
  OFFERED_DRIVER_IDS,
  offerSeqGuard,
  outboxKey,
  outboxPendingGsi2,
  passengerGsi1Pk,
  type ReservationKind,
  reservationKey,
  tripGsi1,
  tripKey,
} from './keys.ts';
import {
  CONCURRENT_UPDATE,
  type Conflict,
  type ExtraItem,
  type TaggedItem,
  tag,
  tagExtra,
  type TransactWriteItem,
  transact,
} from './transact.ts';

export type { ExtraItem, TransactWriteItem } from './transact.ts';

/** Trip-level conflicts; a stale trip version explains everything else, so it ranks first. */
const CONFLICTS = {
  staleVersion: { code: 'CONCURRENT_UPDATE', message: 'The trip was modified concurrently', priority: 0 },
  activeTrip: { code: 'ACTIVE_TRIP_EXISTS', message: 'The passenger already has an active trip', priority: 1 },
  driverBusy: { code: 'DRIVER_BUSY', message: 'The driver already has an active trip', priority: 2 },
  tripExists: { code: 'TRIP_ALREADY_EXISTS', message: 'A trip with this id already exists', priority: 3 },
  other: CONCURRENT_UPDATE,
} satisfies Record<string, Conflict>;

/** The current request's correlation id as an outbox attribute, or nothing outside a request. */
function correlation(): { correlationId?: string } {
  const correlationId = currentCorrelationId();
  return correlationId === undefined ? {} : { correlationId };
}

/** The event without any correlation id it carries: only the current run decides (see `correlation`). */
function withoutCorrelation(event: TripEvent): Omit<TripEvent, 'correlationId'> {
  const rest: Omit<TripEvent, 'correlationId'> & { correlationId?: string } = { ...event };
  delete rest.correlationId;
  return rest;
}

const BATCH_GET_MAX_KEYS = 100;
const BATCH_GET_MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Dispatch bookkeeping stored on the trip item: who holds an offer, and a counter bumped per offer write. */
export type OfferState = { seq: number; driverIds: string[] };

/** Extra condition for `save`: the trip's offer counter must still be the one that was read. */
export type SaveGuard = { offerSeq: number };

export class TripRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  /**
   * Persists a new trip, reserves the passenger's single active-trip slot and writes the outbox event,
   * plus any `extraItems` (e.g. the Idempotency-Key completion), in ONE transaction. Extra items follow
   * the same rules as in `save`.
   */
  async create(trip: Trip, event: TripEvent, extraItems: ExtraItem[] = []): Promise<void> {
    await transact(this.doc, [
      tag(
        { Put: { TableName: this.tableName, Item: this.tripItem(trip), ConditionExpression: 'attribute_not_exists(PK)' } },
        CONFLICTS.tripExists,
      ),
      tag(this.putReservation('PASSENGER', trip.passengerId, trip.id), CONFLICTS.activeTrip),
      tag(this.putOutbox(event), CONFLICTS.other),
      ...extraItems.map(tagExtra),
    ]);
  }

  /**
   * Persists a transition in ONE transaction: the trip (optimistic lock on `before.version`), the
   * outbox event, reservation changes, plus any `extraItems`. DynamoDB rejects a transaction that
   * touches the same item twice, so extra items must not target the trip, its outbox or its reservations.
   * A failed condition on an extra item tagged with `onConditionFailed` raises that error, unless a
   * trip-level conflict (stale version, busy driver...) also failed; untagged extras map to 409
   * CONCURRENT_UPDATE. Extras are sent after the trip items, in the given order.
   * With `guard.offerSeq`, the trip write also requires the offer counter to be unchanged (409
   * CONCURRENT_UPDATE otherwise), so retiring the offers read at that counter cannot miss one.
   * The trip Put replaces the item, so the offer bookkeeping is dropped once the trip is saved.
   */
  async save(
    before: Trip,
    after: Trip,
    event: TripEvent,
    extraItems: ExtraItem[] = [],
    guard?: SaveGuard,
  ): Promise<void> {
    await transact(this.doc, [...this.saveItems(before, after, event, guard), ...extraItems.map(tagExtra)]);
  }

  /** The trip plus its offer bookkeeping, from ONE consistent read. */
  async getWithOffers(id: string): Promise<{ trip: Trip; offers: OfferState } | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: tripKey(id), ConsistentRead: true }));
    if (!res.Item) return null;
    const seq = res.Item[OFFER_SEQ];
    const ids: unknown = res.Item[OFFERED_DRIVER_IDS];
    return {
      trip: toTrip(res.Item),
      offers: {
        seq: typeof seq === 'number' ? seq : 0,
        driverIds: ids instanceof Set ? [...(ids as Set<unknown>)].filter((v): v is string => typeof v === 'string') : [],
      },
    };
  }

  async get(id: string): Promise<Trip | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: tripKey(id), ConsistentRead: true }));
    return res.Item ? toTrip(res.Item) : null;
  }

  /**
   * Trips by id via BatchGetItem (chunks of 100, consistent reads), in the order of `ids`; unknown
   * ids are skipped. Unprocessed keys are retried a bounded number of times, then it throws.
   */
  async getMany(ids: readonly string[]): Promise<Trip[]> {
    const found = new Map<string, Trip>();
    for (let i = 0; i < ids.length; i += BATCH_GET_MAX_KEYS) {
      let keys: Record<string, unknown>[] = ids.slice(i, i + BATCH_GET_MAX_KEYS).map((id) => tripKey(id));
      for (let attempt = 0; keys.length > 0; attempt++) {
        if (attempt === BATCH_GET_MAX_ATTEMPTS) throw new Error(`getMany: ${keys.length} keys still unprocessed`);
        if (attempt > 0) await sleep(2 ** attempt * 25); // back off before retrying throttled keys
        const res = await this.doc.send(
          new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }),
        );
        for (const item of res.Responses?.[this.tableName] ?? []) {
          const trip = toTrip(item);
          found.set(trip.id, trip);
        }
        keys = res.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
      }
    }
    return ids.flatMap((id) => {
      const trip = found.get(id);
      return trip === undefined ? [] : [trip];
    });
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

  private saveItems(before: Trip, after: Trip, event: TripEvent, guard?: SaveGuard): TaggedItem[] {
    if (before.id !== after.id) throw new Error('save: before and after must be the same trip');
    const offers = guard === undefined ? undefined : offerSeqGuard(guard.offerSeq);
    const items: TaggedItem[] = [
      tag(
        {
          Put: {
            TableName: this.tableName,
            Item: this.tripItem(after),
            ConditionExpression: offers === undefined ? '#version = :expected' : `#version = :expected AND ${offers.expression}`,
            ExpressionAttributeNames: { '#version': 'version', ...offers?.names },
            ExpressionAttributeValues: { ':expected': before.version, ...offers?.values },
          },
        },
        CONFLICTS.staleVersion,
      ),
      tag(this.putOutbox(event), CONFLICTS.other),
    ];

    if (after.state === 'ACCEPTED' && after.driverId !== undefined) {
      items.push(tag(this.putReservation('DRIVER', after.driverId, after.id), CONFLICTS.driverBusy));
    }
    if (after.state === 'COMPLETED' || after.state === 'CANCELLED') {
      items.push(tag(this.deleteReservation('PASSENGER', after.passengerId, after.id), CONFLICTS.other));
      // A conditional delete fails on a missing item, so only release a driver slot that was taken.
      if (after.driverId !== undefined) {
        items.push(tag(this.deleteReservation('DRIVER', after.driverId, after.id), CONFLICTS.other));
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
        Item: {
          ...withoutCorrelation(event),
          ...correlation(),
          ...outboxKey(event.tripId, event.version),
          ...outboxPendingGsi2(event.tripId, event.occurredAt, event.version),
          entity: 'EVENT',
        },
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
}

function toTrip(item: Record<string, unknown>): Trip {
  const trip: Record<string, unknown> = { ...item };
  for (const key of KEY_ATTRIBUTES) delete trip[key];
  return trip as unknown as Trip;
}
