import { z } from 'zod';
import { TRIP_EVENT_SCHEMA_VERSION } from '../domain/events.ts';

const TRIP_EVENT_TYPES = [
  'trip.requested',
  'trip.accepted',
  'trip.driver_arrived',
  'trip.started',
  'trip.completed',
  'trip.rated',
  'trip.cancelled',
] as const;

/** A TripEvent (schema version 1) as it travels on the bus; unknown versions are rejected. */
export const tripEventSchema = z.object({
  schemaVersion: z.literal(TRIP_EVENT_SCHEMA_VERSION),
  eventId: z.string().min(1),
  type: z.enum(TRIP_EVENT_TYPES),
  tripId: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  correlationId: z.string().optional(),
});

/** One offer of a trip to one driver, as published to the driver-offers topic (raw SNS delivery). */
export const driverOfferSchema = z.object({
  schemaVersion: z.literal(1),
  offerId: z.string().min(1),
  tripId: z.string().min(1),
  driverId: z.string().min(1),
  offeredAt: z.string().min(1),
  correlationId: z.string().optional(),
});

export type DriverOffer = z.infer<typeof driverOfferSchema>;
