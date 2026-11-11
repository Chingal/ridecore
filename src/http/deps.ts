import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDispatch, type Dispatch } from '../app/dispatch.ts';
import { createDriverService, type DriverService } from '../app/drivers.ts';
import { createTripService, type TripService } from '../app/trips.ts';
import { createDocumentClient } from '../infra/dynamo/client.ts';
import { DriverRepo } from '../infra/dynamo/driver-repo.ts';
import { IdempotencyRepo } from '../infra/dynamo/idempotency-repo.ts';
import { createLocationClient, createLocationNearby } from '../infra/location/client.ts';
import { TripRepo } from '../infra/dynamo/trip-repo.ts';
import { jsonLog, type Logger } from '../log.ts';

export type { LogLine, Logger } from '../log.ts';
export { jsonLog } from '../log.ts';

/** Everything the HTTP layer needs. Built once per Lambda container; tests build their own. */
export interface Deps {
  trips: TripRepo;
  drivers: DriverRepo;
  dispatch: Dispatch;
  idempotency: IdempotencyRepo;
  jwtSecret: string;
  /** Server clock for every use case (rating window, timestamps, idempotency leases). */
  now: () => Date;
  log: Logger;
}

export type DepsOptions = {
  doc: DynamoDBDocumentClient;
  table: string;
  jwtSecret: string;
  now?: () => Date;
  log?: Logger;
  /** ridecore-location (RIDECORE_LOCATION_URL); null or absent keeps dispatch on the DynamoDB index. */
  location?: LocationConfig | null;
};

export type LocationConfig = { url: string; key: string };

export function createDeps(opts: DepsOptions): Deps {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? jsonLog;
  const trips = new TripRepo(opts.doc, opts.table);
  const drivers = new DriverRepo(opts.doc, opts.table);
  return {
    trips,
    drivers,
    dispatch: createDispatch({ trips, drivers, ...nearbyOption(opts.location, drivers) }),
    idempotency: new IdempotencyRepo(opts.doc, opts.table, () => now().getTime(), log),
    jwtSecret: opts.jwtSecret,
    now,
    log,
  };
}

/** The dispatch option for ridecore-location, or nothing (today's behaviour) when it is off. */
export function nearbyOption(location: LocationConfig | null | undefined, drivers: DriverRepo) {
  return location ? { nearby: createLocationNearby(createLocationClient(location), drivers) } : {};
}

/**
 * The ridecore-location switch. `RIDECORE_LOCATION_URL` unset or blank: off (null), and ridecore
 * behaves exactly as without the service. Set: `RIDECORE_LOCATION_KEY` (the service's internal key,
 * at least MIN_JWT_SECRET_LENGTH characters) is required; errors name the variable, never its value.
 */
export function locationFromEnv(env: NodeJS.ProcessEnv = process.env): LocationConfig | null {
  const url = env.RIDECORE_LOCATION_URL?.trim();
  if (!url) return null;
  const key = env.RIDECORE_LOCATION_KEY;
  if (key === undefined || key === '') throw new Error('RIDECORE_LOCATION_KEY is not set (required with RIDECORE_LOCATION_URL)');
  if (key.length < MIN_JWT_SECRET_LENGTH) throw new Error(`RIDECORE_LOCATION_KEY must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  return { url, key };
}

/** Shortest HS256 secret accepted from the environment (256 bits of key material at one byte per char). */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The JWT secret from `RIDECORE_JWT_SECRET`. Fails closed: there is no default, and a missing or
 * short value is a configuration error, never an empty or well-known key.
 */
export function jwtSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.RIDECORE_JWT_SECRET;
  if (secret === undefined || secret === '') throw new Error('RIDECORE_JWT_SECRET is not set');
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`RIDECORE_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
  }
  return secret;
}

/** Composition root for Lambda: table and JWT secret from `RIDECORE_TABLE` / `RIDECORE_JWT_SECRET`. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): Deps {
  const table = env.RIDECORE_TABLE;
  if (!table) throw new Error('RIDECORE_TABLE is not set');
  const jwtSecret = jwtSecretFromEnv(env);
  return createDeps({ doc: createDocumentClient(), table, jwtSecret, location: locationFromEnv(env) });
}

/** The use cases wired to `deps`. Cheap: plain closures over the repositories. */
export function services(deps: Deps): { trips: TripService; drivers: DriverService } {
  return {
    trips: createTripService({ trips: deps.trips, drivers: deps.drivers, dispatch: deps.dispatch }),
    drivers: createDriverService({ drivers: deps.drivers, dispatch: deps.dispatch }),
  };
}
