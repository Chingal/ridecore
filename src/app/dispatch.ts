import { DomainError } from '../domain/errors.ts';
import { toEvent } from '../domain/events.ts';
import { type Actor, type Trip, transition } from '../domain/trip.ts';
import { type DriverRepo, notOffered } from '../infra/dynamo/driver-repo.ts';
import type { TripRepo } from '../infra/dynamo/trip-repo.ts';

/** How many nearby drivers get an offer per `offerTrip` call. */
export const OFFER_FANOUT = 5;

/**
 * Most offers one trip can collect across repeated `offerTrip` calls. Keeps the retire-on-accept
 * transaction (trip items + driver + one Update per offer) far below DynamoDB's 100-item limit.
 */
export const MAX_OFFERS_PER_TRIP = 20;

export type FinishAction = { type: 'COMPLETE' } | { type: 'CANCEL'; reason?: string };

export interface Dispatch {
  /**
   * Offers a REQUESTED trip to the nearest AVAILABLE drivers not offered yet (up to OFFER_FANOUT,
   * and MAX_OFFERS_PER_TRIP in total); returns the newly offered ids, nearest first.
   */
  offerTrip(tripId: string, now?: Date): Promise<string[]>;
  /** The driver accepts an offered trip, in ONE transaction with the driver going ON_TRIP. */
  acceptTrip(tripId: string, driver: Actor, now: Date): Promise<Trip>;
  /** REQUESTED trips offered to this driver, newest offer first. */
  listOffers(driverId: string): Promise<Trip[]>;
  /**
   * COMPLETE or CANCEL a trip; in the same transaction the assigned driver (if any) goes back to
   * AVAILABLE and, when cancelling from REQUESTED, the trip's offers leave the offer index.
   */
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
      const already = new Set(await drivers.tripOfferDriverIds(trip.id));
      const room = Math.min(OFFER_FANOUT, MAX_OFFERS_PER_TRIP - already.size);
      if (room <= 0) return [];
      const ids = (await drivers.availableNear(trip.origin, OFFER_FANOUT + already.size))
        .map((d) => d.id)
        .filter((id) => !already.has(id))
        .slice(0, room);
      await drivers.putOffers(trip.id, ids, now.toISOString());
      return ids;
    },

    async acceptTrip(tripId, driver, now) {
      const before = await load(tripId);
      const offeredTo = await drivers.tripOfferDriverIds(tripId);
      // Checked before the state machine so a driver without an offer learns nothing about the trip.
      // The transaction re-checks the offer, so this read is a fast path, not the guarantee.
      if (driver.role === 'driver' && !offeredTo.includes(driver.id)) throw notOffered();
      const after = transition(before, { type: 'ACCEPT', driverId: driver.id }, driver, now);
      // One transaction: trip + outbox + reservation, the accepting driver's offer (must exist),
      // every other offer leaves the offer index, and the driver goes ON_TRIP.
      await trips.save(before, after, toEvent(before, after), [
        ...drivers.retireOfferItems(tripId, offeredTo, driver.id),
        drivers.takeTripItem(driver.id),
      ]);
      return after;
    },

    async listOffers(driverId) {
      // The index only holds offers of REQUESTED trips; the state filter covers the short window of
      // an offer written while its trip was being accepted (and GSI lag on AWS).
      const offered = await trips.getMany(await drivers.offeredTripIds(driverId));
      return offered.filter((t) => t.state === 'REQUESTED');
    },

    async finishTrip(tripId, action, actor, now) {
      const before = await load(tripId);
      const after = transition(before, action, actor, now);
      // CANCEL from REQUESTED: the trip's offers leave the offer index in the same transaction.
      const retire =
        before.state === 'REQUESTED' ? drivers.retireOfferItems(tripId, await drivers.tripOfferDriverIds(tripId)) : [];
      const release = after.driverId === undefined ? [] : await drivers.releaseItems(after.driverId);
      await trips.save(before, after, toEvent(before, after), [...retire, ...release]);
      return after;
    },
  };
}
