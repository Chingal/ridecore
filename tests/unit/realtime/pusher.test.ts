import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../../src/realtime/messages.ts';
import { createApiGatewayPusher, type Pusher, sendToActor, sendToConnections, wsManagementEndpoint } from '../../../src/realtime/pusher.ts';

const MSG: ServerMessage = { type: 'pong', schemaVersion: 1 };

function fakePusher(outcome: Record<string, 'sent' | 'gone' | Error>): Pusher & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(id) {
      const o = outcome[id] ?? 'sent';
      if (o instanceof Error) throw o;
      if (o === 'sent') sent.push(id);
      return o;
    },
  };
}

function fakeConnections(byActor: string[] = []) {
  const removed: string[] = [];
  return { removed, remove: async (id: string) => void removed.push(id), byActor: async () => byActor };
}

describe('sendToConnections', () => {
  it('sends to every id, removes gone ones, then rethrows the first other error', async () => {
    const boom = Object.assign(new Error('internal'), { name: 'InternalServerError' });
    const pusher = fakePusher({ b: 'gone', c: boom });
    const connections = fakeConnections();

    await expect(sendToConnections(pusher, connections, ['a', 'b', 'c'], MSG)).rejects.toBe(boom);
    expect(pusher.sent).toEqual(['a']);
    expect(connections.removed).toEqual(['b']);
  });

  it('counts sent and gone when every socket is gone, without throwing', async () => {
    const connections = fakeConnections();
    expect(await sendToConnections(fakePusher({ a: 'gone', b: 'gone' }), connections, ['a', 'b'], MSG)).toEqual({ sent: 0, gone: 2 });
    expect(connections.removed).toEqual(['a', 'b']);
  });
});

describe('sendToActor', () => {
  it("sends to every socket of the actor", async () => {
    const pusher = fakePusher({});
    expect(await sendToActor(pusher, fakeConnections(['x', 'y']), { id: 'p1', role: 'passenger' }, MSG)).toEqual({ sent: 2, gone: 0 });
    expect(pusher.sent).toEqual(['x', 'y']);
  });
});

describe('createApiGatewayPusher', () => {
  const client = (err?: Error) => ({ calls: [] as unknown[], async send(cmd: unknown) { this.calls.push(cmd); if (err) throw err; return {}; } });

  it('posts the JSON message and reports sent', async () => {
    const c = client();
    expect(await createApiGatewayPusher('http://x', c).send('abc=', MSG)).toBe('sent');
    const input = (c.calls[0] as { input: { ConnectionId: string; Data: Uint8Array } }).input;
    expect(input.ConnectionId).toBe('abc=');
    expect(JSON.parse(new TextDecoder().decode(input.Data))).toEqual(MSG);
  });

  it('maps GoneException to gone and rethrows anything else', async () => {
    expect(await createApiGatewayPusher('http://x', client(Object.assign(new Error('gone'), { name: 'GoneException' }))).send('a', MSG)).toBe('gone');
    const boom = Object.assign(new Error('slow down'), { name: 'LimitExceededException' });
    await expect(createApiGatewayPusher('http://x', client(boom)).send('a', MSG)).rejects.toBe(boom);
  });
});

describe('wsManagementEndpoint', () => {
  it('builds the Floci subdomain form from AWS_ENDPOINT_URL', () => {
    expect(
      wsManagementEndpoint({ RIDECORE_WS_API_ID: 'abc123', RIDECORE_WS_STAGE: 'dev', AWS_ENDPOINT_URL: 'http://localhost.floci.io:4566' }),
    ).toBe('http://abc123.execute-api.localhost.floci.io:4566/dev');
  });

  it('builds the AWS form from the region without an endpoint override', () => {
    expect(wsManagementEndpoint({ RIDECORE_WS_API_ID: 'abc123', RIDECORE_WS_STAGE: 'prod', AWS_REGION: 'us-east-1' })).toBe(
      'https://abc123.execute-api.us-east-1.amazonaws.com/prod',
    );
  });

  it('fails when the API id or stage is missing', () => {
    expect(() => wsManagementEndpoint({ RIDECORE_WS_STAGE: 'dev' })).toThrow(/RIDECORE_WS_API_ID/);
  });
});
