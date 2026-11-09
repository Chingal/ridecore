import { DomainError } from './errors.ts';
import type { LatLng } from './trip.ts';

export const BASE_FARE = 4000;
export const PER_KM = 1800;
const MIN_DISTINCT_KM = 0.05;
const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function estimateFare(origin: LatLng, destination: LatLng): number {
  return Math.round(BASE_FARE + PER_KM * haversineKm(origin, destination));
}

export function validateLatLng(p: unknown): LatLng {
  const invalid = () =>
    new DomainError('INVALID_COORDINATES', 400, 'Coordinates must be numeric lat in [-90, 90] and lng in [-180, 180]');
  if (typeof p !== 'object' || p === null) throw invalid();
  const { lat, lng } = p as Record<string, unknown>;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw invalid();
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw invalid();
  return { lat, lng };
}

export function assertDistinct(origin: LatLng, destination: LatLng): void {
  if (haversineKm(origin, destination) < MIN_DISTINCT_KM) {
    throw new DomainError('SAME_ORIGIN_DESTINATION', 400, 'Origin and destination must be at least 50 m apart');
  }
}
