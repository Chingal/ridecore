import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../../src/url.ts';

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash', () => {
    expect(trimTrailingSlashes('http://x///')).toBe('http://x');
    expect(trimTrailingSlashes('http://x/')).toBe('http://x');
  });

  it('leaves a url without trailing slashes alone', () => {
    expect(trimTrailingSlashes('http://x/api')).toBe('http://x/api');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('turns an all-slash string into an empty one', () => {
    expect(trimTrailingSlashes('///')).toBe('');
  });
});
