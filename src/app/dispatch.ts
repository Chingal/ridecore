import { DomainError } from '../domain/errors.ts';
import { toEvent } from '../domain/events.ts';
import { type Actor, type Trip, transition } from '../domain/trip.ts';
import { type DriverRepo, notOffered } from '../infra/dynamo/driver-repo.ts';
import { type ResultItem, resultItems } from '../infra/dynamo/transact.ts';
import type { OfferState, TripRepo } from '../infra/dynamo/trip-repo.ts';
import type { LatLng } from '../domain/trip.ts';

/**
 * Where dispatch finds nearby drivers: AVAILABLE drivers near `p`, nearest first, at most `limit`.
 * By default the DynamoDB availability index (DriverRepo); with RIDECORE_LOCATION_URL set, the
 * ridecore-location service (src/infra/location/client.ts).
 */
export interface NearbySource {
  availableNear(p: LatLng, limit: number): Promise<{ id: string }[]>;
}

/** How many nearby drivers get an offer per `offerTrip` call. */
export const OFFER_FANOUT = 5;

/**
 * Most offers one trip can collect, enforced atomically by the offer write's condition on the trip
 * item. Keeps the retire-on-accept transaction (3 trip items + driver + one Update per offer, at
 * most 24 items, 25 with an Idempotency-Key completion) far below DynamoDB's 100-item limit.
 */
export const MAX_OFFERS_PER_TRIP = 20;

export type FinishAction = { type: 'COMPLETE' } | { type: 'CANCEL'; reason?: string };

export interface Dispatch {
  /**
   * Offers a REQUESTED trip to the nearest AVAILABLE drivers not offered yet (up to OFFER_FANOUT,
   * and MAX_OFFERS_PER_TRIP in total); returns the newly offered ids, nearest first.
   */
  offerTrip(tripId: string, now?: Date): Promise<string[]>;
  /**
   * Offers a trip at most once, for the `trip.requested` consumer (redeliveries must not widen the
   * fan-out). Never offered yet: offers it like `offerTrip` and returns the new ids (`fresh: true`,
   * possibly none when no driver is near). Already offered (also by a concurrent call that won):
   * returns the recorded offers (`fresh: false`). No longer REQUESTED: `{ driverIds: [], fresh: false }`.
   */
  offerTripOnce(tripId: string, now?: Date): Promise<{ driverIds: string[]; fresh: boolean }>;
  /**
   * The driver accepts an offered trip, in ONE transaction with the driver going ON_TRIP (and
   * `commit(after)`, when given).
   */
  acceptTrip(tripId: string, driver: Actor, now: Date, commit?: ResultItem<Trip>): Promise<Trip>;
  /** REQUESTED trips offered to this driver, newest offer first. */
  listOffers(driverId: string): Promise<Trip[]>;
  /**
   * COMPLETE or CANCEL a trip; in the same transaction the assigned driver (if any) goes back to
   * AVAILABLE and, when cancelling from REQUESTED, the trip's offers leave the offer index (plus
   * `commit(after)`, when given).
   */
  finishTrip(tripId: string, action: FinishAction, actor: Actor, now: Date, commit?: ResultItem<Trip>): Promise<Trip>;
}

/** `offerTrip` re-reads and retries this many times when concurrent offer writes move `offerSeq`. */
export const OFFER_ATTEMPTS = 5;

const tripNotFound = () => new DomainError('TRIP_NOT_FOUND', 404, 'Trip not found');
const isConcurrentUpdate = (err: unknown) => err instanceof DomainError && err.code === 'CONCURRENT_UPDATE';

export function createDispatch(deps: { trips: TripRepo; drivers: DriverRepo; nearby?: NearbySource }): Dispatch {
  const { trips, drivers } = deps;
  const nearby: NearbySource = deps.nearby ?? drivers;

  async function load(tripId: string): Promise<{ trip: Trip; offers: OfferState }> {
    const found = await trips.getWithOffers(tripId);
    if (found === null) throw tripNotFound();
    return found;
  }

  /**
   * Runs a guarded write, retrying it ONCE on 409 CONCURRENT_UPDATE when only the offer counter
   * moved (a concurrent `offerTrip`). If the trip itself changed (its version moved), the original
   * conflict is rethrown, so a lost accept race stays a CONCURRENT_UPDATE.
   */
  async function withOfferRetry<T>(tripId: string, write: (trip: Trip, offers: OfferState) => Promise<T>): Promise<T> {
    let lost: { version: number; err: unknown } | undefined;
    for (;;) {
      const { trip, offers } = await load(tripId);
      if (lost !== undefined && trip.version !== lost.version) throw lost.err;
      try {
        return await write(trip, offers);
      } catch (err) {
        if (lost !== undefined || !isConcurrentUpdate(err)) throw err;
        lost = { version: trip.version, err };
      }
    }
  }

  return {
    async offerTrip(tripId, now = new Date()) {
      for (let attempt = 0; attempt < OFFER_ATTEMPTS; attempt++) {
        const { trip, offers } = await load(tripId);
        if (trip.state !== 'REQUESTED') {
          throw new DomainError('INVALID_TRANSITION', 409, `Cannot offer a trip in state ${trip.state}`);
        }
        const already = new Set(offers.driverIds);
        const room = Math.min(OFFER_FANOUT, MAX_OFFERS_PER_TRIP - already.size);
        if (room <= 0) return [];
        const ids = (await nearby.availableNear(trip.origin, OFFER_FANOUT + already.size))
          .map((d) => d.id)
          .filter((id) => !already.has(id))
          .slice(0, room);
        if (ids.length === 0) return [];
        try {
          await drivers.putOffers(trip.id, ids, now.toISOString(), {
            offerSeq: offers.seq,
            maxOffers: MAX_OFFERS_PER_TRIP,
          });
          return ids;
        } catch (err) {
          if (!isConcurrentUpdate(err)) throw err;
        }
      }
      throw new DomainError('CONCURRENT_UPDATE', 409, 'The trip offers changed concurrently');
    },

    async offerTripOnce(tripId, now = new Date()) {
      const { trip, offers } = await load(tripId);
      if (trip.state !== 'REQUESTED') return { driverIds: [], fresh: false };
      if (offers.seq > 0) return { driverIds: offers.driverIds, fresh: false };
      const ids = (await nearby.availableNear(trip.origin, OFFER_FANOUT)).map((d) => d.id);
      if (ids.length === 0) return { driverIds: [], fresh: true };
      try {
        // Guarded on the never-offered counter: of two concurrent calls only one writes.
        await drivers.putOffers(trip.id, ids, now.toISOString(), { offerSeq: 0, maxOffers: MAX_OFFERS_PER_TRIP });
        return { driverIds: ids, fresh: true };
      } catch (err) {
        if (!isConcurrentUpdate(err)) throw err;
        const after = await load(tripId);
        if (after.trip.state !== 'REQUESTED') return { driverIds: [], fresh: false };
        // Cancelled but nobody recorded offers (throttling, a transaction conflict): retry the event.
        if (after.offers.seq === 0) throw err;
        return { driverIds: after.offers.driverIds, fresh: false };
      }
    },

    acceptTrip(tripId, driver, now, commit) {
      return withOfferRetry(tripId, async (before, offers) => {
        // Checked before the state machine so a driver without an offer learns nothing about the trip.
        // The transaction re-checks the offer item, so this is a fast path, not the guarantee.
        if (driver.role === 'driver' && !offers.driverIds.includes(driver.id)) throw notOffered();
        const after = transition(before, { type: 'ACCEPT', driverId: driver.id }, driver, now);
        // One transaction: trip (guarded on version AND offerSeq) + outbox + reservation, the accepting
        // driver's offer (must exist), every other offer read at that offerSeq leaves the offer index,
        // and the driver goes ON_TRIP.
        await trips.save(
          before,
          after,
          toEvent(before, after),
          [
            ...drivers.retireOfferItems(tripId, offers.driverIds, driver.id),
            drivers.takeTripItem(driver.id),
            ...resultItems(commit, after),
          ],
          { offerSeq: offers.seq },
        );
        return after;
      });
    },

    async listOffers(driverId) {
      // The index only holds offers of REQUESTED trips; the state filter covers GSI lag on AWS.
      const offered = await trips.getMany(await drivers.offeredTripIds(driverId));
      return offered.filter((t) => t.state === 'REQUESTED');
    },

    finishTrip(tripId, action, actor, now, commit) {
      return withOfferRetry(tripId, async (before, offers) => {
        const after = transition(before, action, actor, now);
        // CANCEL from REQUESTED: the offers read at this offerSeq leave the offer index, guarded on it.
        const fromRequested = before.state === 'REQUESTED';
        const retire = fromRequested ? drivers.retireOfferItems(tripId, offers.driverIds) : [];
        const release = after.driverId === undefined ? [] : await drivers.releaseItems(after.driverId);
        await trips.save(
          before,
          after,
          toEvent(before, after),
          [...retire, ...release, ...resultItems(commit, after)],
          fromRequested ? { offerSeq: offers.seq } : undefined,
        );
        return after;
      });
    },
  };
}
