import type { Trip, TripState } from './trip.ts';

export type TripEventType =
  | 'trip.requested'
  | 'trip.accepted'
  | 'trip.driver_arrived'
  | 'trip.started'
  | 'trip.completed'
  | 'trip.rated'
  | 'trip.cancelled';

export type TripEvent = {
  eventId: string;
  type: TripEventType;
  tripId: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
};

const EVENT_TYPE: Record<TripState, TripEventType> = {
  REQUESTED: 'trip.requested',
  ACCEPTED: 'trip.accepted',
  DRIVER_ARRIVED: 'trip.driver_arrived',
  IN_PROGRESS: 'trip.started',
  COMPLETED: 'trip.completed',
  RATED: 'trip.rated',
  CANCELLED: 'trip.cancelled',
};

/**
 * Builds the event describing the change from `before` to `after` (`before` is null for a new trip).
 * The eventId is derived from tripId + version, so re-emitting the same change yields the same id.
 */
export function toEvent(before: Trip | null, after: Trip): TripEvent {
  return {
    eventId: `${after.id}:${after.version}`,
    type: EVENT_TYPE[after.state],
    tripId: after.id,
    version: after.version,
    occurredAt: after.timestamps[after.state] ?? after.createdAt,
    payload: {
      fromState: before?.state ?? null,
      toState: after.state,
      passengerId: after.passengerId,
      ...(after.driverId === undefined ? {} : { driverId: after.driverId }),
      fareEstimate: after.fareEstimate,
      ...(after.finalFare === undefined ? {} : { finalFare: after.finalFare }),
      ...(after.rating === undefined ? {} : { rating: after.rating }),
      ...(after.cancellation === undefined ? {} : { cancellation: after.cancellation }),
    },
  };
}
