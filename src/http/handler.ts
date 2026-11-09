import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import type { DriverService } from '../app/drivers.ts';
import type { TripService } from '../app/trips.ts';
import { DomainError } from '../domain/errors.ts';
import type { Actor } from '../domain/trip.ts';
import { hashRequest } from '../infra/dynamo/idempotency-repo.ts';
import { verifyToken } from './auth.ts';
import { type Deps, jsonLog, type LogLine, services } from './deps.ts';
import { errorJson, json, toErrorInfo } from './respond.ts';
import { matchRoute, type RouteName } from './routes.ts';
import {
  parseAvailability,
  parseCancel,
  parseIdempotencyKey,
  parseJsonBody,
  parsePosition,
  parseRating,
  parseRequestTrip,
} from './validate.ts';

export type ApiHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

type Result = { status: number; body: unknown; headers?: Record<string, string> };
type Request = { actor: Actor; params: Record<string, string>; body: () => unknown; now: Date };
type Services = { trips: TripService; drivers: DriverService };
/** Validated input (hashed for Idempotency-Key) plus the use case to run with it. */
type Prepared = { input: unknown; run: () => Promise<Result> };
type Endpoint = (req: Request, svc: Services) => Prepared;

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ok = async (work: Promise<unknown>): Promise<Result> => ({ status: 200, body: await work });
const tripRef = (req: Request) => ({ tripId: req.params.id ?? '' });
/** Routes without a body: the body is ignored, nothing to hash beyond method and path. */
const bodyless = (run: () => Promise<Result>): Prepared => ({ input: null, run });

/** Parse/validate first (400 before any write or idempotency claim), then run the use case. */
const ENDPOINTS: Record<RouteName, Endpoint> = {
  requestTrip: (req, s) => {
    const input = parseRequestTrip(req.body());
    return { input, run: async () => ({ status: 201, body: await s.trips.requestTrip(req.actor, input, req.now) }) };
  },
  getTrip: (req, s) => bodyless(() => ok(s.trips.getTrip(req.actor, tripRef(req), req.now))),
  listMyTrips: (req, s) => bodyless(async () => ({ status: 200, body: { items: await s.trips.listMyTrips(req.actor, {}, req.now) } })),
  cancelTrip: (req, s) => {
    const input = parseCancel(req.body());
    return { input, run: () => ok(s.trips.cancelTrip(req.actor, { ...tripRef(req), ...input }, req.now)) };
  },
  rateTrip: (req, s) => {
    const input = parseRating(req.body());
    return { input, run: () => ok(s.trips.rateTrip(req.actor, { ...tripRef(req), ...input }, req.now)) };
  },
  acceptTrip: (req, s) => bodyless(() => ok(s.trips.acceptTrip(req.actor, tripRef(req), req.now))),
  arriveTrip: (req, s) => bodyless(() => ok(s.trips.advanceTrip('ARRIVE')(req.actor, tripRef(req), req.now))),
  startTrip: (req, s) => bodyless(() => ok(s.trips.advanceTrip('START')(req.actor, tripRef(req), req.now))),
  completeTrip: (req, s) => bodyless(() => ok(s.trips.advanceTrip('COMPLETE')(req.actor, tripRef(req), req.now))),
  setAvailability: (req, s) => {
    const input = parseAvailability(req.body());
    return { input, run: () => ok(s.drivers.setAvailability(req.actor, input)) };
  },
  setPosition: (req, s) => {
    const input = parsePosition(req.body());
    return { input, run: () => ok(s.drivers.setPosition(req.actor, input)) };
  },
  listOffers: (req, s) => bodyless(async () => ({ status: 200, body: { items: await s.drivers.listOffers(req.actor) } })),
};

/** API Gateway v2 lower-cases header names; the lookup is case-insensitive anyway for other callers. */
function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function correlationIdOf(event: APIGatewayProxyEventV2): string {
  const given = header(event, 'x-correlation-id');
  return given !== undefined && CORRELATION_ID.test(given) ? given : randomUUID();
}

const routeNotFound = () => new DomainError('ROUTE_NOT_FOUND', 404, 'Route not found');
const forbiddenRole = (role: string) => new DomainError('FORBIDDEN_ROLE', 403, `This route is not available to the ${role} role`);

/**
 * The API: route -> token (401) -> role (403) -> Idempotency-Key (400) -> body (400) -> use case.
 * `source` is the dependencies or a factory called on the first request (Lambda builds them from env
 * once per container). Every response, errors included, carries `x-correlation-id`, and every request
 * logs exactly one JSON line; tokens and bodies are never logged.
 */
export function createHandler(source: Deps | (() => Deps)): ApiHandler {
  let deps: Deps | undefined = typeof source === 'function' ? undefined : source;
  let svc: Services | undefined;

  async function route(event: APIGatewayProxyEventV2, method: string, path: string): Promise<Result> {
    const match = matchRoute(method, path);
    if (match === null) throw routeNotFound();
    deps ??= (source as () => Deps)();
    svc ??= services(deps);
    const actor = await verifyToken(header(event, 'authorization'), deps.jwtSecret);
    if (!match.route.roles.includes(actor.role)) throw forbiddenRole(actor.role);

    const key =
      match.route.idempotencyKey === 'none'
        ? undefined
        : parseIdempotencyKey(header(event, 'idempotency-key'), match.route.idempotencyKey === 'required');
    let parsed: { value: unknown } | undefined;
    const req: Request = {
      actor,
      params: match.params,
      body: () => (parsed ??= { value: parseJsonBody(event.body, event.isBase64Encoded) }).value,
      now: deps.now(),
    };
    const prepared = ENDPOINTS[match.route.name](req, svc);
    if (key === undefined) return prepared.run();

    const result = await deps.idempotency.run(actor.id, key, hashRequest(method, path, prepared.input), prepared.run);
    return {
      status: result.status,
      body: result.body,
      ...(result.replayed ? { headers: { 'idempotent-replayed': 'true' } } : {}),
    };
  }

  return async (event) => {
    const started = performance.now();
    const correlationId = correlationIdOf(event);
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;
    const line: LogLine = { level: 'info', msg: 'request', correlationId, method, path };
    let response: APIGatewayProxyStructuredResultV2;
    try {
      const out = await route(event, method, path);
      response = json(out.status, out.body, correlationId, out.headers);
    } catch (err) {
      const info = toErrorInfo(err);
      response = errorJson(info, correlationId);
      line.code = info.code;
      if (info.status >= 500) {
        line.level = 'error';
        line.error = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.stack !== undefined) line.stack = err.stack;
      } else {
        line.level = 'warn';
      }
    }
    line.status = response.statusCode;
    line.durationMs = Math.round((performance.now() - started) * 100) / 100;
    (deps?.log ?? jsonLog)(line);
    return response;
  };
}
