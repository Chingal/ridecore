import { describe, expect, it } from 'vitest';
import { DomainError } from '../../../src/domain/errors.ts';
import {
  parseAvailability,
  parseCancel,
  parseIdempotencyKey,
  parseJsonBody,
  parsePosition,
  parseRating,
  parseRequestTrip,
} from '../../../src/http/validate.ts';

const POPAYAN = { lat: 2.4448, lng: -76.6147 };
const AIRPORT = { lat: 2.4547, lng: -76.6093 };

function domainError(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('parseJsonBody', () => {
  it('non-JSON body -> 400 INVALID_JSON', () => {
    expect(domainError(() => parseJsonBody('{"origin":', false))).toMatchObject({ code: 'INVALID_JSON', status: 400 });
  });

  it('missing or empty body -> undefined (routes without a body do not fail)', () => {
    expect(parseJsonBody(undefined, false)).toBeUndefined();
    expect(parseJsonBody('', false)).toBeUndefined();
  });

  it('decodes a base64 body', () => {
    const raw = Buffer.from(JSON.stringify({ a: 1 })).toString('base64');
    expect(parseJsonBody(raw, true)).toEqual({ a: 1 });
  });
});

describe('parseRequestTrip', () => {
  it('accepts origin and destination and defaults serviceType to STANDARD', () => {
    expect(parseRequestTrip({ origin: POPAYAN, destination: AIRPORT })).toEqual({
      origin: POPAYAN,
      destination: AIRPORT,
      serviceType: 'STANDARD',
    });
  });

  it('missing destination -> 400 VALIDATION_ERROR naming the field', () => {
    const err = domainError(() => parseRequestTrip({ origin: POPAYAN }));
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(err.message).toContain('destination');
  });

  it('missing body -> 400 VALIDATION_ERROR', () => {
    expect(domainError(() => parseRequestTrip(undefined))).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it('lat 91 -> 400 with the field path', () => {
    const err = domainError(() => parseRequestTrip({ origin: { lat: 91, lng: 0 }, destination: AIRPORT }));
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(err.message).toContain('origin.lat');
  });

  it('non-numeric coordinate -> 400', () => {
    const err = domainError(() => parseRequestTrip({ origin: { lat: '2.4', lng: 0 }, destination: AIRPORT }));
    expect(err.status).toBe(400);
  });

  it('origin = destination -> 400 SAME_ORIGIN_DESTINATION', () => {
    expect(domainError(() => parseRequestTrip({ origin: POPAYAN, destination: POPAYAN }))).toMatchObject({
      code: 'SAME_ORIGIN_DESTINATION',
      status: 400,
    });
  });

  it('a service type other than STANDARD -> 400', () => {
    const err = domainError(() => parseRequestTrip({ origin: POPAYAN, destination: AIRPORT, serviceType: 'PREMIUM' }));
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(err.message).toContain('serviceType');
  });
});

describe('parseRating', () => {
  it('accepts an integer score and an optional comment', () => {
    expect(parseRating({ score: 5, comment: 'Great' })).toEqual({ score: 5, comment: 'Great' });
    expect(parseRating({ score: 1 })).toEqual({ score: 1 });
  });

  it.each([4.5, 0, 6, '5'])('score %s -> 400 VALIDATION_ERROR', (score) => {
    const err = domainError(() => parseRating({ score }));
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
    expect(err.message).toContain('score');
  });

  it('overlong comment -> 400', () => {
    expect(domainError(() => parseRating({ score: 4, comment: 'x'.repeat(501) })).status).toBe(400);
  });
});

describe('parseCancel', () => {
  it('body is optional', () => {
    expect(parseCancel(undefined)).toEqual({});
    expect(parseCancel({ reason: 'Changed plans' })).toEqual({ reason: 'Changed plans' });
  });

  it('non-string reason -> 400', () => {
    expect(domainError(() => parseCancel({ reason: 42 }))).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});

describe('driver bodies', () => {
  it('availability must be AVAILABLE or OFFLINE', () => {
    expect(parseAvailability({ status: 'AVAILABLE' })).toEqual({ status: 'AVAILABLE' });
    expect(domainError(() => parseAvailability({ status: 'ON_TRIP' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('position validates ranges', () => {
    expect(parsePosition(POPAYAN)).toEqual(POPAYAN);
    expect(domainError(() => parsePosition({ lat: 2, lng: 181 })).message).toContain('lng');
  });
});

describe('parseIdempotencyKey', () => {
  it('required and missing -> 400 IDEMPOTENCY_KEY_REQUIRED', () => {
    expect(domainError(() => parseIdempotencyKey(undefined, true))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    });
  });

  it('optional and missing -> undefined', () => {
    expect(parseIdempotencyKey(undefined, false)).toBeUndefined();
  });

  it('malformed key -> 400 INVALID_IDEMPOTENCY_KEY', () => {
    expect(domainError(() => parseIdempotencyKey('has space', true))).toMatchObject({
      code: 'INVALID_IDEMPOTENCY_KEY',
      status: 400,
    });
    expect(domainError(() => parseIdempotencyKey('k'.repeat(256), true)).code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('a UUID key passes', () => {
    expect(parseIdempotencyKey('8b6f3c2e-1d4a-4f5b-9c7e-2a1b3c4d5e6f', true)).toBe('8b6f3c2e-1d4a-4f5b-9c7e-2a1b3c4d5e6f');
  });
});
