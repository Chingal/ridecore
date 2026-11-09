import type { Actor } from '../domain/trip.ts';

export type RouteName =
  | 'requestTrip'
  | 'getTrip'
  | 'listMyTrips'
  | 'cancelTrip'
  | 'rateTrip'
  | 'acceptTrip'
  | 'arriveTrip'
  | 'startTrip'
  | 'completeTrip'
  | 'setAvailability'
  | 'setPosition'
  | 'listOffers';

export interface Route {
  name: RouteName;
  method: 'GET' | 'POST' | 'PUT';
  /** Literal segments and `{param}` placeholders, e.g. `/trips/{id}/accept`. */
  path: string;
  /** Roles allowed on the route; any other role gets 403 FORBIDDEN_ROLE. Per-trip ownership is checked later (404). */
  roles: readonly Actor['role'][];
  idempotencyKey: 'required' | 'optional' | 'none';
}

const BOTH = ['passenger', 'driver'] as const;

/** The public API. The local adapter (Task 7) uses the same table to build `pathParameters`. */
export const ROUTES: readonly Route[] = [
  { name: 'requestTrip', method: 'POST', path: '/trips', roles: ['passenger'], idempotencyKey: 'required' },
  { name: 'getTrip', method: 'GET', path: '/trips/{id}', roles: BOTH, idempotencyKey: 'none' },
  { name: 'listMyTrips', method: 'GET', path: '/me/trips', roles: ['passenger'], idempotencyKey: 'none' },
  { name: 'cancelTrip', method: 'POST', path: '/trips/{id}/cancel', roles: BOTH, idempotencyKey: 'optional' },
  { name: 'rateTrip', method: 'POST', path: '/trips/{id}/rating', roles: ['passenger'], idempotencyKey: 'none' },
  { name: 'acceptTrip', method: 'POST', path: '/trips/{id}/accept', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'arriveTrip', method: 'POST', path: '/trips/{id}/arrive', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'startTrip', method: 'POST', path: '/trips/{id}/start', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'completeTrip', method: 'POST', path: '/trips/{id}/complete', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'setAvailability', method: 'PUT', path: '/drivers/me/availability', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'setPosition', method: 'PUT', path: '/drivers/me/position', roles: ['driver'], idempotencyKey: 'none' },
  { name: 'listOffers', method: 'GET', path: '/drivers/me/offers', roles: ['driver'], idempotencyKey: 'none' },
];

export type RouteMatch = { route: Route; params: Record<string, string> };

/**
 * Path segments of an absolute path, empty ones included: `/trips//x` and `/me/trips/` keep their
 * empty segments, so they match no route. Paths are exact; a trailing slash is not accepted.
 */
const segments = (path: string): string[] | null => (path.startsWith('/') ? path.slice(1).split('/') : null);

/**
 * Matches `method` + raw path (as API Gateway's `rawPath`, still URL-encoded) against ROUTES.
 * Paths match exactly: no empty segments, no trailing slash. Placeholders match exactly one
 * non-empty segment. Returns null for anything else.
 */
export function matchRoute(method: string, rawPath: string): RouteMatch | null {
  const actual = segments(rawPath);
  if (actual === null || actual.includes('')) return null;
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const expected = segments(route.path) ?? [];
    if (expected.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const ok = expected.every((part, i) => {
      const value = actual[i] ?? '';
      if (part.startsWith('{') && part.endsWith('}')) {
        params[part.slice(1, -1)] = value;
        return true;
      }
      return part === value;
    });
    if (ok) return { route, params };
  }
  return null;
}
