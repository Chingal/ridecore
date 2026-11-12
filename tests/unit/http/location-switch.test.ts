import { describe, expect, it } from 'vitest';
import { createDeps, locationFromEnv } from '../../../src/http/deps.ts';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const KEY = 'dev-only-location-internal-key-change-me';

describe('locationFromEnv', () => {
  // Review Focus 4: unset or empty means today's behaviour.
  it.each([[{}], [{ RIDECORE_LOCATION_URL: '' }], [{ RIDECORE_LOCATION_URL: '   ' }]])('is off for %j', (env) => {
    expect(locationFromEnv(env)).toBeNull();
  });

  it('reads the URL and the key', () => {
    expect(locationFromEnv({ RIDECORE_LOCATION_URL: 'http://127.0.0.1:8090', RIDECORE_LOCATION_KEY: KEY })).toEqual({
      url: 'http://127.0.0.1:8090',
      key: KEY,
    });
  });

  it('fails closed without a key, naming the variable', () => {
    expect(() => locationFromEnv({ RIDECORE_LOCATION_URL: 'http://x' })).toThrow('RIDECORE_LOCATION_KEY');
  });

  it('rejects a short key without printing it', () => {
    let message = '';
    try {
      locationFromEnv({ RIDECORE_LOCATION_URL: 'http://x', RIDECORE_LOCATION_KEY: 'short-key-value' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('RIDECORE_LOCATION_KEY');
    expect(message).not.toContain('short-key-value');
  });
});

describe('createDeps with location', () => {
  it('dispatch asks ridecore-location for nearby drivers', async () => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ schemaVersion: 1, drivers: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const trip = {
        id: 't1', passengerId: 'p1', serviceType: 'STANDARD', origin: { lat: 2.45, lng: -76.47 }, destination: { lat: 2.46, lng: -76.47 },
        state: 'REQUESTED', fareEstimate: 1, timestamps: { REQUESTED: 'x' }, version: 1, createdAt: 'x',
      };
      const deps = createDeps({
        doc: {} as DynamoDBDocumentClient,
        table: 't',
        jwtSecret: 'x'.repeat(32),
        location: { url: 'http://loc:8090', key: KEY },
      });
      deps.trips.getWithOffers = async () => ({ trip, offers: { seq: 0, driverIds: [] } }) as never;
      await expect(deps.dispatch.offerTripOnce('t1')).resolves.toEqual({ driverIds: [], fresh: true });
      expect(asked).toEqual(['http://loc:8090/v1/nearby?lat=2.45&lng=-76.47&limit=50']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
