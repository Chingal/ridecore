import type { Actor, LatLng, Trip } from '../domain/trip.ts';
import type { Driver, DriverRepo } from '../infra/dynamo/driver-repo.ts';
import type { ResultItem } from '../infra/dynamo/transact.ts';
import type { Dispatch } from './dispatch.ts';

export type DriverDeps = { drivers: DriverRepo; dispatch: Dispatch };

/** What the API shows of a driver (the geohash cell is an index detail). */
export type DriverView = Omit<Driver, 'geohash5'>;

export interface DriverService {
  /** `commit(view)`, when given, is written in the same transaction as the change. */
  setAvailability(actor: Actor, input: { status: 'AVAILABLE' | 'OFFLINE' }, commit?: ResultItem<DriverView>): Promise<DriverView>;
  setPosition(actor: Actor, input: LatLng, commit?: ResultItem<DriverView>): Promise<DriverView>;
  /** REQUESTED trips currently offered to the driver. */
  listOffers(actor: Actor): Promise<Trip[]>;
}

const view = (d: Driver): DriverView => ({
  id: d.id,
  name: d.name,
  vehicle: d.vehicle,
  availability: d.availability,
  ...(d.position === undefined ? {} : { position: d.position }),
});

export function createDriverService(deps: DriverDeps): DriverService {
  const { drivers, dispatch } = deps;
  const viewCommit = (commit: ResultItem<DriverView> | undefined): ResultItem<Driver> | undefined =>
    commit === undefined ? undefined : (driver) => commit(view(driver));

  return {
    async setAvailability(actor, input, commit) {
      return view(await drivers.setAvailability(actor.id, input.status, viewCommit(commit)));
    },
    async setPosition(actor, input, commit) {
      return view(await drivers.setPosition(actor.id, input, viewCommit(commit)));
    },
    listOffers(actor) {
      return dispatch.listOffers(actor.id);
    },
  };
}
