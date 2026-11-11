import { describe, expect, it } from 'vitest';
import { readConfig } from '../../../src/mcp/config.ts';

const TOKEN = 'eyJ.secret-token.sig';

describe('readConfig', () => {
  it('reads the API URL and the passenger token', () => {
    expect(readConfig({ RIDECORE_API_URL: 'http://localhost:3000', RIDECORE_MCP_TOKEN: TOKEN })).toEqual({
      baseUrl: 'http://localhost:3000',
      token: TOKEN,
    });
  });

  it('names a missing or empty variable', () => {
    for (const name of ['RIDECORE_API_URL', 'RIDECORE_MCP_TOKEN']) {
      const env = { RIDECORE_API_URL: 'https://api.example.test', RIDECORE_MCP_TOKEN: TOKEN };
      expect(() => readConfig({ ...env, [name]: undefined })).toThrow(name);
      expect(() => readConfig({ ...env, [name]: '' })).toThrow(name);
    }
  });

  it('accepts only an http or https API URL, without echoing the token', () => {
    for (const url of ['ftp://x', 'not a url']) {
      let message = '';
      try {
        readConfig({ RIDECORE_API_URL: url, RIDECORE_MCP_TOKEN: TOKEN });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('RIDECORE_API_URL');
      expect(message).not.toContain(TOKEN);
    }
  });
});
