import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../../src/http/routes.ts';

describe('matchRoute', () => {
  it('matches exact paths and extracts placeholders', () => {
    expect(matchRoute('post', '/trips/abc/accept')).toMatchObject({ route: { name: 'acceptTrip' }, params: { id: 'abc' } });
    expect(matchRoute('GET', '/me/trips')).toMatchObject({ route: { name: 'listMyTrips' }, params: {} });
  });

  it.each(['/trips//abc', '//me/trips', '/trips//accept', '/me/trips/', 'me/trips', '/trips/abc/'])(
    '%s does not match (no empty segments, no trailing slash)',
    (path) => {
      expect(matchRoute(path.includes('accept') ? 'POST' : 'GET', path)).toBeNull();
    },
  );

  it('the same path with another method does not match', () => {
    expect(matchRoute('DELETE', '/trips')).toBeNull();
  });
});
