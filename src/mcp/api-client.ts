import { randomUUID } from 'node:crypto';
import type { LatLng, Trip } from '../domain/trip.ts';

/** A trip as the HTTP API returns it. */
export type ApiTrip = Trip;

export const API_TIMEOUT_MS = 10_000;

/** An API error (`{"error":{"code","message"}}`), or `status` 0 when the API could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

/** The four passenger routes the MCP tools need (ADR 0003), called with one passenger token. */
export interface ApiClient {
  requestTrip(input: { origin: LatLng; destination: LatLng }): Promise<Trip>;
  getTrip(tripId: string): Promise<Trip>;
  cancelTrip(tripId: string, reason?: string): Promise<Trip>;
  listMyTrips(): Promise<Trip[]>;
}

export type ApiClientOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The Idempotency-Key for each new trip request; a random UUID by default. */
  newKey?: () => string;
};

export function createApiClient(opts: ApiClientOptions): ApiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? API_TIMEOUT_MS;
  const newKey = opts.newKey ?? randomUUID;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    const init: RequestInit = {
      method,
      signal,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    // The race also covers a fetch implementation that ignores the signal.
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    // Headers and body both count against the timeout: a body that stalls is as unavailable as no answer.
    let res: Response;
    let text: string;
    try {
      [res, text] = await Promise.race([
        doFetch(`${baseUrl}${path}`, init).then(async (r) => [r, await r.text()] as const),
        aborted,
      ]);
    } catch {
      throw new ApiError(0, 'API_UNAVAILABLE', `The ridecore API at ${baseUrl} did not answer`);
    }
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.ok) {
      if (typeof parsed !== 'object' || parsed === null) throw unexpected(res.status);
      return parsed;
    }
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    if (typeof error?.code === 'string' && typeof error.message === 'string') throw new ApiError(res.status, error.code, error.message);
    throw new ApiError(res.status, 'API_ERROR', `The ridecore API answered ${res.status}`);
  }

  const unexpected = (status: number) =>
    new ApiError(status, 'API_ERROR', `The ridecore API at ${baseUrl} answered ${status} with an unexpected body (is RIDECORE_API_URL right?)`);
  const asTrip = (body: unknown, status = 200): Trip => {
    if (typeof (body as { id?: unknown }).id !== 'string') throw unexpected(status);
    return body as Trip;
  };

  const tripPath = (tripId: string) => `/trips/${encodeURIComponent(tripId)}`;

  return {
    requestTrip: async (input) =>
      asTrip(await call('POST', '/trips', { origin: input.origin, destination: input.destination }, { 'idempotency-key': newKey() }), 201),
    getTrip: async (tripId) => asTrip(await call('GET', tripPath(tripId))),
    cancelTrip: async (tripId, reason) =>
      asTrip(await call('POST', `${tripPath(tripId)}/cancel`, reason === undefined ? undefined : { reason })),
    listMyTrips: async () => {
      const { items } = (await call('GET', '/me/trips')) as { items?: unknown };
      if (!Array.isArray(items)) throw unexpected(200);
      return items.map((item) => asTrip(item));
    },
  };
}
