import { DomainError } from '../domain/errors.ts';
import type { Actor, LatLng, Trip } from '../domain/trip.ts';
import type { Driver, DriverRepo } from '../infra/dynamo/driver-repo.ts';
import type { Dispatch } from './dispatch.ts';

export type DriverDeps = { drivers: DriverRepo; dispatch: Dispatch };

/** What the API shows of a driver (the geohash cell is an index detail). */
export type DriverView = Omit<Driver, 'geohash5'>;

export interface DriverService {
  setAvailability(actor: Actor, input: { status: 'AVAILABLE' | 'OFFLINE' }): Promise<DriverView>;
  setPosition(actor: Actor, input: LatLng): Promise<DriverView>;
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

  async function current(id: string): Promise<DriverView> {
    const driver = await drivers.get(id);
    if (driver === null) throw new DomainError('DRIVER_NOT_FOUND', 404, 'Driver not found');
    return view(driver);
  }

  return {
    async setAvailability(actor, input) {
      await drivers.setAvailability(actor.id, input.status);
      return current(actor.id);
    },
    async setPosition(actor, input) {
      await drivers.setPosition(actor.id, input);
      return current(actor.id);
    },
    listOffers(actor) {
      return dispatch.listOffers(actor.id);
    },
  };
}
