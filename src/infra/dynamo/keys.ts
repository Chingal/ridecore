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

/** Attributes that belong to the storage layout, not to the domain object. */
export const KEY_ATTRIBUTES: readonly string[] = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entity'];

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
