import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { signToken } from '../../../src/http/auth.ts';
import { createDeps, depsFromEnv, MIN_JWT_SECRET_LENGTH } from '../../../src/http/deps.ts';
import { createHandler } from '../../../src/http/handler.ts';

const SECRET = 'x'.repeat(MIN_JWT_SECRET_LENGTH);

/** A DynamoDB client that is down: every call fails like an unexpected infrastructure error. */
const downDoc = { send: async () => { throw new Error('dynamodb unavailable'); } } as unknown as DynamoDBDocumentClient;

function event(method: string, path: string, token?: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'x-correlation-id': 'corr-1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    requestContext: { http: { method, path } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('error reporting from the HTTP handler', () => {
  it('reports an unexpected 500 once, with correlation id, method and path', async () => {
    const report = vi.fn(async () => undefined);
    const api = createHandler(createDeps({ doc: downDoc, table: 't', jwtSecret: SECRET, log: () => undefined, report }));
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);

    const res = await api(event('GET', '/me/trips', token));

    expect(res.statusCode).toBe(500);
    expect(report).toHaveBeenCalledOnce();
    const [err, context] = report.mock.calls[0] as unknown as [Error, Record<string, string>];
    expect(err.message).toBe('dynamodb unavailable');
    expect(context).toEqual({ correlationId: 'corr-1', method: 'GET', route: 'listMyTrips' });
  });

  it('does not report domain errors (4xx are answers, not bugs)', async () => {
    const report = vi.fn(async () => undefined);
    const api = createHandler(createDeps({ doc: downDoc, table: 't', jwtSecret: SECRET, log: () => undefined, report }));

    expect((await api(event('GET', '/me/trips'))).statusCode).toBe(401);
    expect((await api(event('GET', '/nope'))).statusCode).toBe(404);
    expect(report).not.toHaveBeenCalled();
  });

  it('still answers 500 when the reporter itself fails', async () => {
    const report = vi.fn(async () => { throw new Error('reporter bug'); });
    const api = createHandler(createDeps({ doc: downDoc, table: 't', jwtSecret: SECRET, log: () => undefined, report }));
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);

    expect((await api(event('GET', '/me/trips', token))).statusCode).toBe(500);
  });

  it('tags the route name, never the raw path (a path segment can carry a token)', async () => {
    const report = vi.fn(async () => undefined);
    const api = createHandler(createDeps({ doc: downDoc, table: 't', jwtSecret: SECRET, log: () => undefined, report }));
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);
    const ev = event('POST', `/trips/${token}/cancel`, token);
    ev.headers['idempotency-key'] = 'k-1';

    expect((await api(ev)).statusCode).toBe(500);
    const context = (report.mock.calls[0] as unknown as [Error, Record<string, string>])[1];
    expect(JSON.stringify(context)).not.toContain(token);
    expect(context.route).toBe('cancelTrip');
  });

  it('logs the request line before reporting, and survives a reporter that throws synchronously', async () => {
    const order: string[] = [];
    const report = vi.fn((): Promise<void> => { order.push('report'); throw new Error('sync bug'); });
    const api = createHandler(createDeps({ doc: downDoc, table: 't', jwtSecret: SECRET, log: () => order.push('log'), report }));
    const token = await signToken({ id: 'p-1', role: 'passenger' }, SECRET);

    expect((await api(event('GET', '/me/trips', token))).statusCode).toBe(500);
    expect(order).toEqual(['log', 'report']);
  });

  it('depsFromEnv turns reporting on only with SENTRY_DSN', () => {
    const base = { RIDECORE_TABLE: 't', RIDECORE_JWT_SECRET: SECRET };
    expect(depsFromEnv(base).report).toBeUndefined();
    expect(depsFromEnv({ ...base, SENTRY_DSN: 'http://k@localhost:8000/1' }).report).toBeTypeOf('function');
  });
});
