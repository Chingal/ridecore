import { describe, expect, it } from 'vitest';
import {
  BASE_FARE,
  PER_KM,
  assertDistinct,
  estimateFare,
  haversineKm,
  validateLatLng,
} from '../../../src/domain/fare.ts';
import { DomainError } from '../../../src/domain/errors.ts';

const centre = { lat: 2.4419, lng: -76.6063 };
const airport = { lat: 2.4545, lng: -76.6093 };

function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error('expected to throw');
}

describe('haversineKm', () => {
  it('measures centre to airport at about 1.44 km', () => {
    expect(haversineKm(centre, airport)).toBeCloseTo(1.44, 1);
    expect(Math.abs(haversineKm(centre, airport) - 1.44)).toBeLessThan(0.05);
  });
  it('is zero for identical points', () => {
    expect(haversineKm(centre, centre)).toBe(0);
  });
});

describe('estimateFare', () => {
  it('uses base fare plus per-km rate, rounded', () => {
    expect(BASE_FARE).toBe(4000);
    expect(PER_KM).toBe(1800);
    expect(estimateFare(centre, airport)).toBe(Math.round(4000 + 1800 * haversineKm(centre, airport)));
  });
});

describe('validateLatLng', () => {
  it('accepts boundary values', () => {
    expect(validateLatLng({ lat: 90, lng: 180 })).toEqual({ lat: 90, lng: 180 });
    expect(validateLatLng({ lat: -90, lng: -180 })).toEqual({ lat: -90, lng: -180 });
  });
  it('rejects out-of-range latitude', () => {
    const e = thrown(() => validateLatLng({ lat: 90.0001, lng: 0 }));
    expect(e.status).toBe(400);
    expect(e.code).toBe('INVALID_COORDINATES');
  });
  it('rejects out-of-range longitude', () => {
    expect(thrown(() => validateLatLng({ lat: 0, lng: 180.0001 })).status).toBe(400);
  });
  it('rejects non-numbers, NaN and non-objects', () => {
    for (const bad of [{ lat: '2.4', lng: 0 }, { lat: NaN, lng: 0 }, { lat: 0 }, null, undefined, 'x', 5]) {
      const e = thrown(() => validateLatLng(bad));
      expect(e.code).toBe('INVALID_COORDINATES');
      expect(e.status).toBe(400);
    }
  });
});

describe('assertDistinct', () => {
  it('rejects identical points', () => {
    const e = thrown(() => assertDistinct(centre, centre));
    expect(e.status).toBe(400);
    expect(e.code).toBe('SAME_ORIGIN_DESTINATION');
  });
  it('rejects points closer than 0.05 km', () => {
    expect(thrown(() => assertDistinct(centre, { lat: centre.lat + 0.0002, lng: centre.lng })).status).toBe(400);
  });
  it('accepts distinct points', () => {
    expect(() => assertDistinct(centre, airport)).not.toThrow();
  });
});
