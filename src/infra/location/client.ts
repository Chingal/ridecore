import type { NearbySource } from '../../app/dispatch.ts';
import type { LatLng } from '../../domain/trip.ts';
import type { Availability } from '../dynamo/driver-repo.ts';

/**
 * How many nearby drivers dispatch asks ridecore-location for. It knows positions, not availability,
 * so dispatch over-fetches and keeps those still AVAILABLE in DynamoDB (one batch read).
 */
export const LOCATION_OVERFETCH = 50;

/** Default timeout of one nearby query: short, so a slow service fails the message and SQS retries it. */
export const LOCATION_TIMEOUT_MS = 2000;

export interface LocationClient {
  /** Ids of fresh drivers near `p`, nearest first, at most `limit`. */
  nearby(p: LatLng, limit: number): Promise<string[]>;
}

/**
 * ridecore-location could not answer. An infrastructure failure, not a client error: the dispatch
 * consumer reports the message as failed so SQS retries it, and an HTTP caller gets 500 INTERNAL.
 */
export class LocationUnavailableError extends Error {
  readonly code = 'LOCATION_UNAVAILABLE';
  constructor(why: string) {
    super(`ridecore-location is unavailable: ${why}`);
    this.name = 'LocationUnavailableError';
  }
}

const unavailable = (why: string) => new LocationUnavailableError(why);

/**
 * Client of ridecore-location's `GET /v1/nearby` (its docs/contracts.md), authenticated with the
 * internal service key. Every failure (network, timeout, non-200, unexpected body) is a
 * LocationUnavailableError.
 */
export function createLocationClient(opts: { url: string; key: string; fetch?: typeof fetch; timeoutMs?: number }): LocationClient {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LOCATION_TIMEOUT_MS;
  return {
    async nearby(p, limit) {
      const url = `${base}/v1/nearby?lat=${p.lat}&lng=${p.lng}&limit=${limit}`;
      let body: unknown;
      try {
        const res = await doFetch(url, {
          headers: { authorization: `Bearer ${opts.key}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) throw unavailable(`status ${res.status}`);
        body = await res.json();
      } catch (err) {
        if (err instanceof LocationUnavailableError) throw err;
        throw unavailable(err instanceof Error ? err.name : 'request failed');
      }
      const parsed = body as { schemaVersion?: unknown; drivers?: unknown };
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.drivers)) throw unavailable('unexpected response');
      return parsed.drivers.map((d) => {
        const id = (d as { driverId?: unknown }).driverId;
        if (typeof id !== 'string' || id === '') throw unavailable('unexpected response');
        return id;
      });
    },
  };
}

/**
 * The nearby source dispatch uses when ridecore-location is on: the nearest LOCATION_OVERFETCH fresh
 * drivers from the service, keeping only those AVAILABLE in DynamoDB, in the service's order.
 */
export function createLocationNearby(
  client: LocationClient,
  drivers: { availabilityOf(ids: readonly string[]): Promise<Map<string, Availability>> },
): NearbySource {
  return {
    async availableNear(p, limit) {
      const ids = await client.nearby(p, LOCATION_OVERFETCH);
      if (ids.length === 0) return [];
      const availability = await drivers.availabilityOf(ids);
      return ids
        .filter((id) => availability.get(id) === 'AVAILABLE')
        .slice(0, limit)
        .map((id) => ({ id }));
    },
  };
}
