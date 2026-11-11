import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import ngeohash from 'ngeohash';
import type { LatLng } from '../domain/trip.ts';
import { createDocumentClient, createDynamoClient } from '../infra/dynamo/client.ts';
import { ConnectionRepo } from '../infra/dynamo/connection-repo.ts';
import { tableNameFromEnv } from '../infra/dynamo/keys.ts';
import { ThrottleRepo } from '../infra/dynamo/throttle-repo.ts';
import { TripRepo } from '../infra/dynamo/trip-repo.ts';
import { jsonLog, type Logger } from '../log.ts';
import type { ServerMessage } from './messages.ts';
import { createApiGatewayPusher, type Pusher, sendToActor, sendToConnections, wsManagementEndpoint } from './pusher.ts';

/** At most one position push per driver in this window (ADR 0005). */
export const POSITION_THROTTLE_MS = 3000;

/** Stream records older than this are skipped: a late position is stale, and the driver may be on another trip by now. */
export const POSITION_MAX_AGE_MS = 30_000;

export type PositionsDeps = {
  connections: Pick<ConnectionRepo, 'watchersOf' | 'byActor' | 'remove'>;
  throttle: Pick<ThrottleRepo, 'once'>;
  trips: Pick<TripRepo, 'activeTripId' | 'get'>;
  pusher: Pusher;
  log: Logger;
  now?: () => Date;
};

type DriverImage = {
  id: string;
  availability: string;
  category: string;
  position?: LatLng;
  cell?: string;
};

function driverOf(image: Record<string, AttributeValue> | undefined): DriverImage | null {
  if (image === undefined) return null;
  const item = unmarshall(image);
  if (item.entity !== 'DRIVER' || typeof item.id !== 'string') return null;
  const position = item.position as LatLng | undefined;
  return {
    id: item.id,
    availability: String(item.availability),
    category: String((item.vehicle as { category?: unknown } | undefined)?.category ?? ''),
    ...(position === undefined ? {} : { position: { lat: position.lat, lng: position.lng } }),
    ...(typeof item.geohash5 === 'string' ? { cell: item.geohash5 } : {}),
  };
}

/**
 * Driver items from the table stream (a second mapping, filter `entity: DRIVER`) → map pushes:
 * - AVAILABLE with a position: `car` to passengers watching its cell or a neighbour (throttled);
 * - OFFLINE: `car.left` to those watchers;
 * - ON_TRIP: `car.left` to the watchers and `driver_position` to that trip's passenger only (each throttled
 *   in its own scope).
 * Records older than POSITION_MAX_AGE_MS are skipped (a stale position could reach a later trip's passenger).
 * The stream is NEW_IMAGE, so a car that moves to another cell leaves the old cell's maps by the
 * client's expiry. Nothing here writes a driver item, so it can never trigger itself. A failing push
 * reports its record and stops; the stream retries from it (positions are best effort).
 */
export function createPositionsHandler(deps: PositionsDeps): (event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse> {
  const now = deps.now ?? (() => new Date());
  const { connections, pusher } = deps;

  const toWatchers = async (cell: string, message: ServerMessage) => {
    const ids = await connections.watchersOf([cell, ...ngeohash.neighbors(cell)]);
    await sendToConnections(pusher, connections, ids, message);
  };

  const handle = async (driver: DriverImage) => {
    const at = now();
    if (driver.availability === 'OFFLINE') {
      if (driver.cell !== undefined) await toWatchers(driver.cell, { type: 'car.left', schemaVersion: 1, driverId: driver.id });
      return;
    }
    if (driver.position === undefined || driver.cell === undefined) return;
    // `car.left` has its own throttle scope, so a recent `car` never holds it back.
    if (driver.availability === 'ON_TRIP' && (await deps.throttle.once('left', driver.id, at, POSITION_THROTTLE_MS))) {
      await toWatchers(driver.cell, { type: 'car.left', schemaVersion: 1, driverId: driver.id });
    }
    if (!(await deps.throttle.once('position', driver.id, at, POSITION_THROTTLE_MS))) return;

    if (driver.availability === 'AVAILABLE') {
      await toWatchers(driver.cell, {
        type: 'car',
        schemaVersion: 1,
        driverId: driver.id,
        category: driver.category,
        position: driver.position,
        at: at.toISOString(),
      });
      return;
    }
    if (driver.availability === 'ON_TRIP') {
      const tripId = await deps.trips.activeTripId('DRIVER', driver.id);
      const trip = tripId === null ? null : await deps.trips.get(tripId);
      if (trip === null) return;
      await sendToActor(pusher, connections, { id: trip.passengerId, role: 'passenger' }, {
        type: 'driver_position',
        schemaVersion: 1,
        tripId: trip.id,
        position: driver.position,
        at: at.toISOString(),
      });
    }
  };

  return async (event) => {
    for (const record of event.Records) {
      const driver = driverOf(record.dynamodb?.NewImage as Record<string, AttributeValue> | undefined);
      if (driver === null) continue;
      const createdAt = record.dynamodb?.ApproximateCreationDateTime;
      if (createdAt !== undefined && now().getTime() - createdAt * 1000 > POSITION_MAX_AGE_MS) continue;
      try {
        await handle(driver);
      } catch (err) {
        deps.log({ level: 'error', msg: 'position push failed', driverId: driver.id, error: err instanceof Error ? err.message : String(err) });
        return { batchItemFailures: [{ itemIdentifier: record.dynamodb?.SequenceNumber ?? '' }] };
      }
    }
    return { batchItemFailures: [] };
  };
}

let lambda: ((event: DynamoDBStreamEvent) => Promise<DynamoDBBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/positions.mjs`). */
export const handler = (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  if (lambda === undefined) {
    const doc = createDocumentClient(createDynamoClient());
    const table = tableNameFromEnv();
    lambda = createPositionsHandler({
      connections: new ConnectionRepo(doc, table),
      throttle: new ThrottleRepo(doc, table),
      trips: new TripRepo(doc, table),
      pusher: createApiGatewayPusher(wsManagementEndpoint()),
      log: jsonLog,
    });
  }
  return lambda(event);
};
