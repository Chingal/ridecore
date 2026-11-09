import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDispatch, type Dispatch } from '../app/dispatch.ts';
import { createDriverService, type DriverService } from '../app/drivers.ts';
import { createTripService, type TripService } from '../app/trips.ts';
import { createDocumentClient } from '../infra/dynamo/client.ts';
import { DriverRepo } from '../infra/dynamo/driver-repo.ts';
import { IdempotencyRepo } from '../infra/dynamo/idempotency-repo.ts';
import { TripRepo } from '../infra/dynamo/trip-repo.ts';

export type LogLine = Record<string, unknown>;
export type Logger = (line: LogLine) => void;

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
};

/** One JSON line on stdout (stderr for errors), which CloudWatch keeps as a structured record. */
export const jsonLog: Logger = (line) => {
  const text = JSON.stringify(line);
  if (line.level === 'error') console.error(text);
  else console.log(text);
};

export function createDeps(opts: DepsOptions): Deps {
  const now = opts.now ?? (() => new Date());
  const trips = new TripRepo(opts.doc, opts.table);
  const drivers = new DriverRepo(opts.doc, opts.table);
  return {
    trips,
    drivers,
    dispatch: createDispatch({ trips, drivers }),
    idempotency: new IdempotencyRepo(opts.doc, opts.table, () => now().getTime()),
    jwtSecret: opts.jwtSecret,
    now,
    log: opts.log ?? jsonLog,
  };
}

/** Composition root for Lambda: table and JWT secret from `RIDECORE_TABLE` / `RIDECORE_JWT_SECRET`. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): Deps {
  const table = env.RIDECORE_TABLE;
  const jwtSecret = env.RIDECORE_JWT_SECRET;
  if (!table) throw new Error('RIDECORE_TABLE is not set');
  if (!jwtSecret) throw new Error('RIDECORE_JWT_SECRET is not set');
  return createDeps({ doc: createDocumentClient(), table, jwtSecret });
}

/** The use cases wired to `deps`. Cheap: plain closures over the repositories. */
export function services(deps: Deps): { trips: TripService; drivers: DriverService } {
  return {
    trips: createTripService({ trips: deps.trips, drivers: deps.drivers, dispatch: deps.dispatch }),
    drivers: createDriverService({ drivers: deps.drivers, dispatch: deps.dispatch }),
  };
}
