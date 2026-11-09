import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import ngeohash from 'ngeohash';
import { DomainError } from '../../domain/errors.ts';
import { haversineKm, validateLatLng } from '../../domain/fare.ts';
import type { LatLng } from '../../domain/trip.ts';
import {
  availabilityCellPk,
  driverGsi1Pk,
  driverGsi2,
  driverKey,
  GSI1,
  GSI2,
  KEY_ATTRIBUTES,
  OFFER_PREFIX,
  offerGsi1,
  offerKey,
} from './keys.ts';
import type { ExtraItem } from './trip-repo.ts';

export type Availability = 'OFFLINE' | 'AVAILABLE' | 'ON_TRIP';

export interface Driver {
  id: string;
  name: string;
  vehicle: { plate: string; model: string; category: string };
  availability: Availability;
  position?: LatLng;
  geohash5?: string;
}

/** What a driver registers or updates. `ON_TRIP` is only ever set by accepting a trip. */
export type DriverProfile = Omit<Driver, 'availability' | 'geohash5'> & { availability: 'OFFLINE' | 'AVAILABLE' };

export const GEOHASH_PRECISION = 5;

/** How many times a read-then-conditional-write is retried when the driver changed in between. */
const MAX_ATTEMPTS = 3;

const driverNotFound = () => new DomainError('DRIVER_NOT_FOUND', 404, 'Driver not found');
const driverOnTrip = () => new DomainError('DRIVER_ON_TRIP', 409, 'The driver is on a trip');
export const notOffered = () => new DomainError('NOT_OFFERED', 404, 'This trip was not offered to the driver');
const driverChanged = () => new DomainError('CONCURRENT_UPDATE', 409, 'The driver was modified concurrently');

export const cellOf = (p: LatLng): string => ngeohash.encode(p.lat, p.lng, GEOHASH_PRECISION);

/**
 * Driver profile and availability (`DRIVER#<id>/META`) plus trip offers (`TRIP#<tripId>/OFFER#<driverId>`).
 * The META item carries the sparse GSI2 keys (`AVAIL#<geohash5>`) only while the driver is AVAILABLE
 * with a known position, so querying GSI2 by cell only ever returns drivers who can take a trip.
 */
export class DriverRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(doc: DynamoDBDocumentClient, tableName: string) {
    this.doc = doc;
    this.tableName = tableName;
  }

  /** Creates or replaces a driver. Refused with 409 DRIVER_ON_TRIP while the stored driver is on a trip. */
  async upsert(profile: DriverProfile): Promise<Driver> {
    const position = profile.position === undefined ? undefined : validateLatLng(profile.position);
    const driver: Driver = {
      ...profile,
      ...(position === undefined ? {} : { position, geohash5: cellOf(position) }),
    };
    const cell = driver.availability === 'AVAILABLE' ? driver.geohash5 : undefined;
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...driver,
            ...driverKey(driver.id),
            ...(cell === undefined ? {} : driverGsi2(cell, driver.id)),
            entity: 'DRIVER',
          },
          ConditionExpression: 'attribute_not_exists(PK) OR #availability <> :onTrip',
          ExpressionAttributeNames: { '#availability': 'availability' },
          ExpressionAttributeValues: { ':onTrip': 'ON_TRIP' },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw driverOnTrip();
      throw err;
    }
    return driver;
  }

  async get(id: string): Promise<Driver | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: driverKey(id), ConsistentRead: true }));
    return res.Item ? toDriver(res.Item) : null;
  }

  /** Goes online/offline. 404 DRIVER_NOT_FOUND for an unknown driver, 409 DRIVER_ON_TRIP while on a trip. */
  async setAvailability(id: string, availability: 'AVAILABLE' | 'OFFLINE'): Promise<void> {
    await this.mutate(id, (current) => {
      if (current.availability === 'ON_TRIP') throw driverOnTrip();
      return { availability, geohash5: current.geohash5 };
    });
  }

  /** Records the driver's position; while AVAILABLE the driver moves to the new cell of the index. */
  async setPosition(id: string, p: LatLng): Promise<void> {
    const position = validateLatLng(p);
    await this.mutate(id, (current) => ({ availability: current.availability, geohash5: cellOf(position), position }));
  }

  /**
   * AVAILABLE drivers in the geohash-5 cell of `p` and its 8 neighbours, nearest first, at most `limit`.
   * GSI2 is eventually consistent on AWS, so a driver who just changed may be missing or stale for a moment.
   */
  async availableNear(p: LatLng, limit: number): Promise<Driver[]> {
    const center = cellOf(validateLatLng(p));
    const cells = [center, ...ngeohash.neighbors(center)];
    const pages = await Promise.all(cells.map((cell) => this.queryCell(cell)));
    return pages
      .flat()
      .filter((d): d is Driver & { position: LatLng } => d.availability === 'AVAILABLE' && d.position !== undefined)
      .map((d) => ({ driver: d, km: haversineKm(p, d.position) }))
      .sort((a, b) => a.km - b.km || a.driver.id.localeCompare(b.driver.id))
      .slice(0, limit)
      .map(({ driver }) => driver);
  }

  /** Writes one offer item per driver (idempotent: re-offering overwrites). */
  async putOffers(tripId: string, driverIds: readonly string[], createdAt: string): Promise<void> {
    if (driverIds.length === 0) return;
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: driverIds.map((driverId) => ({
          Put: {
            TableName: this.tableName,
            Item: {
              ...offerKey(tripId, driverId),
              ...offerGsi1(driverId, createdAt),
              tripId,
              driverId,
              createdAt,
              entity: 'OFFER',
            },
          },
        })),
      }),
    );
  }

  async hasOffer(tripId: string, driverId: string): Promise<boolean> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: offerKey(tripId, driverId), ConsistentRead: true }),
    );
    return res.Item !== undefined;
  }

  /** Trip ids offered to the driver, newest offer first. */
  async offeredTripIds(driverId: string, limit = 50): Promise<string[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1.indexName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :offer)',
        ExpressionAttributeNames: { '#pk': GSI1.partitionKey, '#sk': GSI1.sortKey },
        ExpressionAttributeValues: { ':pk': driverGsi1Pk(driverId), ':offer': OFFER_PREFIX },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []).flatMap((item) => (typeof item.tripId === 'string' ? [item.tripId] : []));
  }

  /** Accept-transaction items: the offer must exist (404 NOT_OFFERED). */
  offerCheckItem(tripId: string, driverId: string): ExtraItem {
    return {
      item: {
        ConditionCheck: {
          TableName: this.tableName,
          Key: offerKey(tripId, driverId),
          ConditionExpression: 'attribute_exists(PK)',
        },
      },
      onConditionFailed: notOffered(),
    };
  }

  /**
   * Accept-transaction item: AVAILABLE -> ON_TRIP and out of the availability index. The condition
   * lives on the update itself (a transaction cannot touch the same item twice).
   */
  takeTripItem(driverId: string): ExtraItem {
    return {
      item: {
        Update: {
          TableName: this.tableName,
          Key: driverKey(driverId),
          UpdateExpression: 'SET #availability = :onTrip REMOVE GSI2PK, GSI2SK',
          ConditionExpression: '#availability = :available',
          ExpressionAttributeNames: { '#availability': 'availability' },
          ExpressionAttributeValues: { ':onTrip': 'ON_TRIP', ':available': 'AVAILABLE' },
        },
      },
      onConditionFailed: new DomainError('DRIVER_NOT_AVAILABLE', 409, 'The driver is not available'),
    };
  }

  /**
   * Item that returns the driver to AVAILABLE when its trip completes or is cancelled, back in the
   * availability index only if it has a position. Reads the driver to know its cell; the update is
   * conditioned on that cell so a concurrent `setPosition` makes the transaction fail with 409
   * CONCURRENT_UPDATE instead of indexing a stale cell. Returns [] for a driver without a META item.
   */
  async releaseItems(driverId: string): Promise<ExtraItem[]> {
    const current = await this.get(driverId);
    if (current === null) return [];
    const gh = current.geohash5;
    const cellCondition = gh === undefined ? 'attribute_not_exists(geohash5)' : 'geohash5 = :gh';
    return [
      {
        item: {
          Update: {
            TableName: this.tableName,
            Key: driverKey(driverId),
            UpdateExpression:
              gh === undefined
                ? 'SET #availability = :available'
                : 'SET #availability = :available, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
            ConditionExpression: `attribute_exists(PK) AND ${cellCondition}`,
            ExpressionAttributeNames: { '#availability': 'availability' },
            ExpressionAttributeValues: {
              ':available': 'AVAILABLE',
              ...(gh === undefined ? {} : { ':gh': gh, ...gsi2Values(gh, driverId) }),
            },
          },
        },
        onConditionFailed: driverChanged(),
      },
    ];
  }

  private async queryCell(cell: string): Promise<Driver[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2.indexName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': GSI2.partitionKey },
        ExpressionAttributeValues: { ':pk': availabilityCellPk(cell) },
      }),
    );
    return (res.Items ?? []).map(toDriver);
  }

  /**
   * Read-then-conditional-write of availability/position. GSI2 keys cannot be built from stored
   * attributes inside an UpdateExpression, so the next state is computed from a read and written
   * only if availability and cell are still what was read; otherwise it re-reads (a few times).
   */
  private async mutate(
    id: string,
    next: (current: Driver) => { availability: Availability; geohash5: string | undefined; position?: LatLng },
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.get(id);
      if (current === null) throw driverNotFound();
      const target = next(current);
      const indexed = target.availability === 'AVAILABLE' && target.geohash5 !== undefined;

      const set = ['#availability = :availability'];
      const values: Record<string, unknown> = { ':availability': target.availability, ':seen': current.availability };
      if (target.position !== undefined && target.geohash5 !== undefined) {
        set.push('#position = :position', 'geohash5 = :newGh');
        values[':position'] = target.position;
        values[':newGh'] = target.geohash5;
      }
      if (indexed && target.geohash5 !== undefined) {
        set.push('GSI2PK = :gsi2pk', 'GSI2SK = :gsi2sk');
        Object.assign(values, gsi2Values(target.geohash5, id));
      }
      let condition = 'attribute_exists(PK) AND #availability = :seen';
      if (current.geohash5 === undefined) {
        condition += ' AND attribute_not_exists(geohash5)';
      } else {
        condition += ' AND geohash5 = :seenGh';
        values[':seenGh'] = current.geohash5;
      }

      try {
        await this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: driverKey(id),
            UpdateExpression: `SET ${set.join(', ')}${indexed ? '' : ' REMOVE GSI2PK, GSI2SK'}`,
            ConditionExpression: condition,
            ExpressionAttributeNames: {
              '#availability': 'availability',
              ...(target.position === undefined ? {} : { '#position': 'position' }),
            },
            ExpressionAttributeValues: values,
          }),
        );
        return;
      } catch (err) {
        if (!(err instanceof ConditionalCheckFailedException)) throw err;
      }
    }
    throw driverChanged();
  }
}

function gsi2Values(geohash5: string, driverId: string): Record<string, string> {
  const keys = driverGsi2(geohash5, driverId);
  return { ':gsi2pk': keys.GSI2PK, ':gsi2sk': keys.GSI2SK };
}

function toDriver(item: Record<string, unknown>): Driver {
  const driver: Record<string, unknown> = { ...item };
  for (const key of KEY_ATTRIBUTES) delete driver[key];
  return driver as unknown as Driver;
}
