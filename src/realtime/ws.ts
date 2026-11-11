import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import type { DriverService } from '../app/drivers.ts';
import type { DriverRepo } from '../infra/dynamo/driver-repo.ts';
import { DomainError } from '../domain/errors.ts';
import { verifyRawToken } from '../http/auth.ts';
import { createDeps, jwtSecretFromEnv, locationFromEnv, services } from '../http/deps.ts';
import { createDocumentClient } from '../infra/dynamo/client.ts';
import { ConnectionRepo } from '../infra/dynamo/connection-repo.ts';
import { cellOf } from '../infra/dynamo/driver-repo.ts';
import { tableNameFromEnv } from '../infra/dynamo/keys.ts';
import { ThrottleRepo } from '../infra/dynamo/throttle-repo.ts';
import { jsonLog, type Logger } from '../log.ts';
import { clientMessageSchema, type ServerMessage } from './messages.ts';
import { createApiGatewayPusher, type Pusher, wsManagementEndpoint } from './pusher.ts';

/** The subprotocol a client offers first; the second offered value is its token (ADR 0005). */
export const SUBPROTOCOL = 'ridecore.v1';

/** The WebSocket event as API Gateway (and Floci) delivers it; `$connect` also carries the headers. */
export type WsEvent = APIGatewayProxyWebsocketEventV2 & { headers?: Record<string, string | undefined> };

export type WsResult = { statusCode: number; headers?: Record<string, string>; body?: string };

export type WsDeps = {
  connections: Pick<ConnectionRepo, 'put' | 'get' | 'remove' | 'watch'>;
  drivers: Pick<DriverService, 'setPosition'>;
  /** Cars already parked around a newly watched point (a read of the availability index). */
  cars: Pick<DriverRepo, 'availableNear'>;
  pusher: Pusher;
  throttle: Pick<ThrottleRepo, 'once'>;
  secret: string;
  log: Logger;
  now?: () => Date;
};

const OK: WsResult = { statusCode: 200 };

/** At most this many parked cars are sent when a passenger starts watching (nearest first). */
export const WATCH_SNAPSHOT_LIMIT = 50;

/** One snapshot per passenger in this window (all their sockets together), so nobody sweeps the city cell by cell. */
export const WATCH_SNAPSHOT_WINDOW_MS = 10_000;

/** The token offered as `Sec-WebSocket-Protocol: ridecore.v1, <token>`; undefined for any other shape. */
function offeredToken(headers: WsEvent['headers']): string | undefined {
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'sec-websocket-protocol')?.[1];
  const [protocol, token, ...rest] = (header ?? '').split(',').map((part) => part.trim());
  return protocol === SUBPROTOCOL && token !== undefined && token !== '' && rest.length === 0 ? token : undefined;
}

const error = (code: string, message: string): ServerMessage => ({ type: 'error', schemaVersion: 1, code, message });

/**
 * `$connect` authenticates the dev JWT from the subprotocol and stores the connection; `$disconnect`
 * removes it; `$default` routes `watch` (passengers), `position` (drivers) and `ping`. Replies travel
 * as pushes, so `$default` always answers 200. A `$default` without a connection id is an HTTP request
 * (Floci's path form, ADR 0005) and is ignored. The token never reaches a log line.
 */
export function createWsHandler(deps: WsDeps): (event: WsEvent) => Promise<WsResult> {
  const now = deps.now ?? (() => new Date());
  const { connections, pusher, log } = deps;

  const reply = async (connectionId: string, message: ServerMessage) => {
    await pusher.send(connectionId, message);
  };

  return async (event) => {
    const { routeKey, connectionId } = event.requestContext;
    if (connectionId === undefined || connectionId === '') return OK;

    if (routeKey === '$connect') {
      const token = offeredToken(event.headers);
      let actor;
      try {
        if (token === undefined) throw new Error('no token offered');
        actor = await verifyRawToken(token, deps.secret);
      } catch {
        log({ level: 'info', msg: 'connection rejected', connectionId });
        return { statusCode: 401 };
      }
      await connections.put({ connectionId, actor, connectedAt: now().toISOString() }, now());
      log({ level: 'info', msg: 'connected', connectionId, role: actor.role, actorId: actor.id });
      return { statusCode: 200, headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL } };
    }

    if (routeKey === '$disconnect') {
      await connections.remove(connectionId);
      log({ level: 'info', msg: 'disconnected', connectionId });
      return OK;
    }

    const connection = await connections.get(connectionId);
    if (connection === null) return OK;
    const { actor } = connection;

    let parsed;
    try {
      parsed = clientMessageSchema.safeParse(JSON.parse(event.body ?? ''));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      await reply(connectionId, error('INVALID_MESSAGE', 'Expected {"action":"watch"|"position","lat","lng"} or {"action":"ping"}'));
      return OK;
    }
    const msg = parsed.data;

    if (msg.action === 'ping') {
      await reply(connectionId, { type: 'pong', schemaVersion: 1 });
    } else if (msg.action === 'watch') {
      if (actor.role !== 'passenger') await reply(connectionId, error('FORBIDDEN', 'Only passengers watch the map'));
      else {
        const point = { lat: msg.lat, lng: msg.lng };
        await connections.watch(connectionId, cellOf(point));
        // Cars only push when they move; send the ones already parked here so the map is not empty.
        // Rate-limited per passenger, not per socket (ADR 0005): watching keeps working, the snapshot does not repeat.
        const at = now().toISOString();
        const snapshot = await deps.throttle.once('watch', actor.id, now(), WATCH_SNAPSHOT_WINDOW_MS);
        for (const car of snapshot ? await deps.cars.availableNear(point, WATCH_SNAPSHOT_LIMIT) : []) {
          if (car.position === undefined) continue;
          await reply(connectionId, { type: 'car', schemaVersion: 1, driverId: car.id, category: car.vehicle.category, position: car.position, at });
        }
      }
    } else if (actor.role !== 'driver') {
      await reply(connectionId, error('FORBIDDEN', 'Only drivers send positions'));
    } else {
      try {
        await deps.drivers.setPosition(actor, { lat: msg.lat, lng: msg.lng });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        await reply(connectionId, error(err.code, err.message));
      }
    }
    return OK;
  };
}

let lambda: ((event: WsEvent) => Promise<WsResult>) | undefined;

/** Lambda entry point (bundled to `dist/ws.mjs`) for `$connect`, `$disconnect` and `$default`. */
export const handler = (event: WsEvent): Promise<WsResult> => {
  if (lambda === undefined) {
    const doc = createDocumentClient();
    const table = tableNameFromEnv();
    const secret = jwtSecretFromEnv();
    const deps = createDeps({ doc, table, jwtSecret: secret, location: locationFromEnv() });
    lambda = createWsHandler({
      connections: new ConnectionRepo(doc, table),
      drivers: services(deps).drivers,
      cars: deps.drivers,
      pusher: createApiGatewayPusher(wsManagementEndpoint()),
      throttle: new ThrottleRepo(doc, table),
      secret,
      log: jsonLog,
    });
  }
  return lambda(event);
};
