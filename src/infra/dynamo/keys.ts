/**
 * Single-table layout for ridecore. This module is plain data (no AWS SDK or CDK imports) so the
 * CDK stack and the integration-test table helper build the table from the same definition.
 * It also runs under Node native type stripping (CDK app), so no enums/namespaces here.
 */

export const DEFAULT_TABLE_NAME = 'ridecore';

export function tableNameFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.RIDECORE_TABLE ?? DEFAULT_TABLE_NAME;
}

export type KeyPair = { readonly partitionKey: string; readonly sortKey: string };

/** Key schema, indexes, TTL and stream settings of the ridecore table (all key attributes are strings). */
export const TABLE_DEFINITION = {
  partitionKey: 'PK',
  sortKey: 'SK',
  globalSecondaryIndexes: [
    { indexName: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' },
    { indexName: 'GSI2', partitionKey: 'GSI2PK', sortKey: 'GSI2SK' },
  ],
  timeToLiveAttribute: 'expiresAt',
  streamViewType: 'NEW_IMAGE',
} as const;

export const GSI1 = TABLE_DEFINITION.globalSecondaryIndexes[0];

/** Offer bookkeeping kept on the trip item (dispatch only, not part of the domain Trip). */
export const OFFER_SEQ = 'offerSeq';
export const OFFERED_DRIVER_IDS = 'offeredDriverIds';

/** Attributes that belong to the storage layout or dispatch bookkeeping, not to the domain object. */
export const KEY_ATTRIBUTES: readonly string[] = [
  'PK',
  'SK',
  'GSI1PK',
  'GSI1SK',
  'GSI2PK',
  'GSI2SK',
  'entity',
  OFFER_SEQ,
  OFFERED_DRIVER_IDS,
];

export type ConditionPart = { expression: string; names: Record<string, string>; values: Record<string, unknown> };

/**
 * Condition that the trip's offer counter is still `seen` (a trip never offered has no counter,
 * which counts as 0). Shared by offer writes and by the transitions that retire offers.
 */
export function offerSeqGuard(seen: number): ConditionPart {
  return {
    expression: seen === 0 ? '(attribute_not_exists(#offerSeq) OR #offerSeq = :seenOfferSeq)' : '#offerSeq = :seenOfferSeq',
    names: { '#offerSeq': OFFER_SEQ },
    values: { ':seenOfferSeq': seen },
  };
}

export type ReservationKind = 'PASSENGER' | 'DRIVER';

export const tripKey = (tripId: string) => ({ PK: `TRIP#${tripId}`, SK: 'META' });

export const tripGsi1 = (passengerId: string, createdAt: string, tripId: string) => ({
  GSI1PK: passengerGsi1Pk(passengerId),
  GSI1SK: `TRIP#${createdAt}#${tripId}`,
});

export const passengerGsi1Pk = (passengerId: string) => `PASSENGER#${passengerId}`;

export const reservationKey = (kind: ReservationKind, id: string) => ({ PK: `${kind}#${id}`, SK: 'ACTIVE' });

export const outboxKey = (tripId: string, version: number) => ({
  PK: `TRIP#${tripId}`,
  SK: `EVENT#${String(version).padStart(6, '0')}`,
});

export const GSI2 = TABLE_DEFINITION.globalSecondaryIndexes[1];

export const driverKey = (driverId: string) => ({ PK: `DRIVER#${driverId}`, SK: 'META' });

/** Sparse GSI2 keys: present on a driver's META item only while it is AVAILABLE with a position. */
export const driverGsi2 = (geohash5: string, driverId: string) => ({
  GSI2PK: availabilityCellPk(geohash5),
  GSI2SK: `DRIVER#${driverId}`,
});

export const availabilityCellPk = (geohash5: string) => `AVAIL#${geohash5}`;

export const OFFER_PREFIX = 'OFFER#';

export const offerKey = (tripId: string, driverId: string) => ({ PK: `TRIP#${tripId}`, SK: `${OFFER_PREFIX}${driverId}` });

/** GSI1 keys of an offer, for a driver's "my offers" query. */
export const offerGsi1 = (driverId: string, createdAt: string) => ({
  GSI1PK: driverGsi1Pk(driverId),
  GSI1SK: `${OFFER_PREFIX}${createdAt}`,
});

export const driverGsi1Pk = (driverId: string) => `DRIVER#${driverId}`;
