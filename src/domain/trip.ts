import { DomainError } from './errors.ts';

export type TripState =
  | 'REQUESTED'
  | 'ACCEPTED'
  | 'DRIVER_ARRIVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'RATED'
  | 'CANCELLED';

export type Actor = { id: string; role: 'passenger' | 'driver' };
export type LatLng = { lat: number; lng: number };

export interface Trip {
  id: string;
  passengerId: string;
  driverId?: string;
  serviceType: 'STANDARD';
  origin: LatLng;
  destination: LatLng;
  state: TripState;
  fareEstimate: number;
  finalFare?: number;
  rating?: { score: 1 | 2 | 3 | 4 | 5; comment?: string };
  cancellation?: { by: 'passenger' | 'driver'; reason?: string };
  timestamps: Partial<Record<TripState, string>>;
  version: number;
  createdAt: string;
}

export type TripAction =
  | { type: 'ACCEPT'; driverId: string }
  | { type: 'ARRIVE' }
  | { type: 'START' }
  | { type: 'COMPLETE' }
  | { type: 'RATE'; score: number; comment?: string }
  | { type: 'CANCEL'; reason?: string };

type ActionType = TripAction['type'];

export const RATING_WINDOW_MS = 24 * 60 * 60 * 1000;

const TRANSITIONS: Record<TripState, Partial<Record<ActionType, TripState>>> = {
  REQUESTED: { ACCEPT: 'ACCEPTED', CANCEL: 'CANCELLED' },
  ACCEPTED: { ARRIVE: 'DRIVER_ARRIVED', CANCEL: 'CANCELLED' },
  DRIVER_ARRIVED: { START: 'IN_PROGRESS', CANCEL: 'CANCELLED' },
  IN_PROGRESS: { COMPLETE: 'COMPLETED' },
  COMPLETED: { RATE: 'RATED' },
  RATED: {},
  CANCELLED: {},
};

const ACTIVE_STATES: ReadonlySet<TripState> = new Set<TripState>([
  'REQUESTED',
  'ACCEPTED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
]);

export function isActive(state: TripState): boolean {
  return ACTIVE_STATES.has(state);
}

function forbidden(message: string): DomainError {
  return new DomainError('FORBIDDEN', 403, message);
}

function notFound(): DomainError {
  return new DomainError('TRIP_NOT_FOUND', 404, 'Trip not found');
}

/** Role and ownership checks. Runs before the state check so a stranger learns nothing about the trip. */
function checkActor(trip: Trip, action: TripAction, actor: Actor): void {
  switch (action.type) {
    case 'ACCEPT':
      if (actor.role !== 'driver') throw forbidden('Only drivers can accept a trip');
      if (action.driverId !== actor.id) throw forbidden('A driver can only accept a trip for themselves');
      return;
    case 'ARRIVE':
    case 'START':
    case 'COMPLETE':
      if (actor.role !== 'driver') throw forbidden('Only the assigned driver can perform this action');
      if (trip.driverId !== undefined && trip.driverId !== actor.id) throw notFound();
      return;
    case 'RATE':
      if (actor.role !== 'passenger') throw forbidden('Only the passenger can rate a trip');
      if (trip.passengerId !== actor.id) throw notFound();
      return;
    case 'CANCEL':
      if (actor.role === 'passenger') {
        if (trip.passengerId !== actor.id) throw notFound();
      } else if (trip.state === 'REQUESTED') {
        throw forbidden('Only the passenger can cancel a requested trip');
      } else if (trip.driverId !== actor.id) {
        throw notFound();
      }
      return;
  }
}

function checkRating(trip: Trip, score: number, now: Date): 1 | 2 | 3 | 4 | 5 {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new DomainError('INVALID_RATING', 400, 'Rating score must be an integer between 1 and 5');
  }
  const completedAt = trip.timestamps.COMPLETED;
  if (completedAt !== undefined && now.getTime() - new Date(completedAt).getTime() > RATING_WINDOW_MS) {
    throw new DomainError('RATING_WINDOW_CLOSED', 422, 'Trips can only be rated within 24 hours of completion');
  }
  return score as 1 | 2 | 3 | 4 | 5;
}

export function transition(trip: Trip, action: TripAction, actor: Actor, now: Date): Trip {
  checkActor(trip, action, actor);

  const next = TRANSITIONS[trip.state][action.type];
  if (next === undefined) {
    throw new DomainError('INVALID_TRANSITION', 409, `Cannot ${action.type} a trip in state ${trip.state}`);
  }

  const updated: Trip = {
    ...trip,
    state: next,
    version: trip.version + 1,
    timestamps: { ...trip.timestamps, [next]: now.toISOString() },
  };

  switch (action.type) {
    case 'ACCEPT':
      updated.driverId = action.driverId;
      break;
    case 'COMPLETE':
      updated.finalFare = trip.fareEstimate;
      break;
    case 'RATE': {
      const score = checkRating(trip, action.score, now);
      updated.rating = action.comment === undefined ? { score } : { score, comment: action.comment };
      break;
    }
    case 'CANCEL':
      updated.cancellation = {
        by: actor.role,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      };
      break;
    default:
      break;
  }
  return updated;
}
