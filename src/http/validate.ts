import { z } from 'zod';
import { DomainError } from '../domain/errors.ts';
import { assertDistinct } from '../domain/fare.ts';
import type { LatLng } from '../domain/trip.ts';

const MAX_REASON = 200;
const MAX_COMMENT = 500;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

const latLng = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const requestTripSchema = z.object({
  origin: latLng,
  destination: latLng,
  serviceType: z.literal('STANDARD').default('STANDARD'),
});

const cancelSchema = z.object({ reason: z.string().trim().min(1).max(MAX_REASON).optional() });

const ratingSchema = z.object({
  score: z.int().min(1).max(5),
  comment: z.string().trim().max(MAX_COMMENT).optional(),
});

const availabilitySchema = z.object({ status: z.enum(['AVAILABLE', 'OFFLINE']) });

export type RequestTripInput = { origin: LatLng; destination: LatLng; serviceType: 'STANDARD' };
export type CancelInput = { reason?: string };
export type RatingInput = { score: number; comment?: string };
export type AvailabilityInput = { status: 'AVAILABLE' | 'OFFLINE' };

const validationError = (message: string) => new DomainError('VALIDATION_ERROR', 400, message);

/** Parses with `schema`; any issue becomes 400 VALIDATION_ERROR naming the field path (`origin.lat: ...`). */
function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const message = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? 'body' : issue.path.map(String).join('.')}: ${issue.message}`)
    .join('; ');
  throw validationError(message);
}

/** The JSON body, or `undefined` when there is none. A non-empty body that is not JSON is 400 INVALID_JSON. */
export function parseJsonBody(raw: string | undefined, isBase64Encoded: boolean): unknown {
  if (raw === undefined || raw === '') return undefined;
  const text = isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('INVALID_JSON', 400, 'Request body must be valid JSON');
  }
}

export function parseRequestTrip(body: unknown): RequestTripInput {
  const input = parse(requestTripSchema, body);
  assertDistinct(input.origin, input.destination);
  return input;
}

/** The body is optional: no body means no reason. */
export function parseCancel(body: unknown): CancelInput {
  const { reason } = parse(cancelSchema, body ?? {});
  return reason === undefined ? {} : { reason };
}

export function parseRating(body: unknown): RatingInput {
  const { score, comment } = parse(ratingSchema, body);
  return comment === undefined || comment === '' ? { score } : { score, comment };
}

export function parseAvailability(body: unknown): AvailabilityInput {
  return parse(availabilitySchema, body);
}

export function parsePosition(body: unknown): LatLng {
  return parse(latLng, body);
}

/** `Idempotency-Key`: 1-255 visible ASCII characters. */
export function parseIdempotencyKey(header: string | undefined, required: true): string;
export function parseIdempotencyKey(header: string | undefined, required: boolean): string | undefined;
export function parseIdempotencyKey(header: string | undefined, required: boolean): string | undefined {
  if (header === undefined || header === '') {
    if (required) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, 'The Idempotency-Key header is required');
    return undefined;
  }
  if (!IDEMPOTENCY_KEY.test(header)) {
    throw new DomainError('INVALID_IDEMPOTENCY_KEY', 400, 'Idempotency-Key must be 1-255 visible ASCII characters');
  }
  return header;
}
