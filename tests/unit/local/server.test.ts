import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { startLocalServer } from '../../../src/local/server.ts';

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function withStub(
  response: APIGatewayProxyStructuredResultV2 = { statusCode: 201, headers: { 'x-correlation-id': 'c-1' }, body: '{"ok":true}' },
) {
  const seen: APIGatewayProxyEventV2[] = [];
  server = await startLocalServer(0, async (event) => {
    seen.push(event);
    return response;
  });
  const { port } = server.address() as AddressInfo;
  return { seen, base: `http://127.0.0.1:${port}` };
}

describe('local adapter', () => {
  it('translates a request into an HTTP API v2 event and writes the result back', async () => {
    const { seen, base } = await withStub();
    const res = await fetch(`${base}/trips/abc/cancel?x=1`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Idempotency-Key': 'k1', 'content-type': 'application/json' },
      body: '{"reason":"late"}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-correlation-id')).toBe('c-1');
    expect(await res.json()).toEqual({ ok: true });

    const event = seen[0];
    expect(event).toMatchObject({
      version: '2.0',
      rawPath: '/trips/abc/cancel',
      rawQueryString: 'x=1',
      pathParameters: { id: 'abc' },
      body: '{"reason":"late"}',
      isBase64Encoded: false,
      requestContext: { http: { method: 'POST', path: '/trips/abc/cancel' } },
    });
    expect(event?.headers).toMatchObject({ authorization: 'Bearer t', 'idempotency-key': 'k1' });
  });

  it('sends no body and no pathParameters when there are none', async () => {
    const { seen, base } = await withStub({ statusCode: 200, headers: {}, body: '' });
    expect((await fetch(`${base}/me/trips`)).status).toBe(200);
    expect(seen[0]?.body).toBeUndefined();
    expect(seen[0]?.pathParameters).toBeUndefined();
    expect(seen[0]?.requestContext.http.method).toBe('GET');
  });

  it('binds to loopback (127.0.0.1) by default', async () => {
    await withStub();
    expect((server?.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('answers 500 INTERNAL if the handler itself rejects', async () => {
    server = await startLocalServer(0, async () => {
      throw new Error('boom');
    });
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/me/trips`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL');
  });
});
