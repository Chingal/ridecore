import { DomainError } from '../domain/errors.ts';
import { toEvent } from '../domain/events.ts';
import { type Actor, type Trip, transition } from '../domain/trip.ts';
import { type DriverRepo, notOffered } from '../infra/dynamo/driver-repo.ts';
import type { TripRepo } from '../infra/dynamo/trip-repo.ts';

/** How many nearby drivers get an offer for each requested trip. */
export const OFFER_FANOUT = 5;

export type FinishAction = { type: 'COMPLETE' } | { type: 'CANCEL'; reason?: string };

export interface Dispatch {
  /** Offers a REQUESTED trip to the nearest AVAILABLE drivers; returns their ids, nearest first. */
  offerTrip(tripId: string, now?: Date): Promise<string[]>;
  /** The driver accepts an offered trip, in ONE transaction with the driver going ON_TRIP. */
  acceptTrip(tripId: string, driver: Actor, now: Date): Promise<Trip>;
  /** REQUESTED trips offered to this driver, newest offer first. */
  listOffers(driverId: string): Promise<Trip[]>;
  /** COMPLETE or CANCEL a trip; the assigned driver (if any) goes back to AVAILABLE in the same transaction. */
  finishTrip(tripId: string, action: FinishAction, actor: Actor, now: Date): Promise<Trip>;
}

const tripNotFound = () => new DomainError('TRIP_NOT_FOUND', 404, 'Trip not found');

export function createDispatch(deps: { trips: TripRepo; drivers: DriverRepo }): Dispatch {
  const { trips, drivers } = deps;

  async function load(tripId: string): Promise<Trip> {
    const trip = await trips.get(tripId);
    if (trip === null) throw tripNotFound();
    return trip;
  }

  return {
    async offerTrip(tripId, now = new Date()) {
      const trip = await load(tripId);
      if (trip.state !== 'REQUESTED') {
        throw new DomainError('INVALID_TRANSITION', 409, `Cannot offer a trip in state ${trip.state}`);
      }
      const ids = (await drivers.availableNear(trip.origin, OFFER_FANOUT)).map((d) => d.id);
      await drivers.putOffers(trip.id, ids, now.toISOString());
      return ids;
    },

    async acceptTrip(tripId, driver, now) {
      const before = await load(tripId);
      // Checked before the state machine so a driver without an offer learns nothing about the trip.
      // The transaction re-checks the offer, so this read is a fast path, not the guarantee.
      if (driver.role === 'driver' && !(await drivers.hasOffer(tripId, driver.id))) throw notOffered();
      const after = transition(before, { type: 'ACCEPT', driverId: driver.id }, driver, now);
      await trips.save(before, after, toEvent(before, after), [
        drivers.offerCheckItem(tripId, driver.id),
        drivers.takeTripItem(driver.id),
      ]);
      return after;
    },

    async listOffers(driverId) {
      const ids = await drivers.offeredTripIds(driverId);
      const offered = await Promise.all(ids.map((id) => trips.get(id)));
      return offered.filter((t): t is Trip => t !== null && t.state === 'REQUESTED');
    },

    async finishTrip(tripId, action, actor, now) {
      const before = await load(tripId);
      const after = transition(before, action, actor, now);
      const release = after.driverId === undefined ? [] : await drivers.releaseItems(after.driverId);
      await trips.save(before, after, toEvent(before, after), release);
      return after;
    },
  };
}
