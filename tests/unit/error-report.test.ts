import { describe, expect, it, vi } from 'vitest';
import { createErrorReporter, errorReporterFromEnv, parseDsn } from '../../src/error-report.ts';

const DSN = 'http://abc123@localhost:8000/7';

describe('parseDsn', () => {
  it('splits a Sentry-protocol DSN into store URL and public key', () => {
    expect(parseDsn(DSN)).toEqual({ storeUrl: 'http://localhost:8000/api/7/store/', publicKey: 'abc123' });
  });

  it('keeps a path prefix before the project id', () => {
    expect(parseDsn('https://k@errors.example.com/sentry/3')).toEqual({
      storeUrl: 'https://errors.example.com/sentry/api/3/store/',
      publicKey: 'k',
    });
  });

  it('rejects a DSN without key or project id, without echoing it', () => {
    for (const bad of ['http://localhost:8000/7', 'http://k@localhost:8000/', 'not a url']) {
      expect(() => parseDsn(bad)).toThrow('SENTRY_DSN is not a valid DSN');
      expect(() => parseDsn(bad)).not.toThrow(bad);
    }
  });
});

describe('errorReporterFromEnv', () => {
  it('is off (undefined) when SENTRY_DSN is unset or blank', () => {
    expect(errorReporterFromEnv({})).toBeUndefined();
    expect(errorReporterFromEnv({ SENTRY_DSN: '  ' })).toBeUndefined();
  });

  it('builds a reporter when SENTRY_DSN is set', () => {
    expect(errorReporterFromEnv({ SENTRY_DSN: DSN })).toBeTypeOf('function');
  });
});

describe('createErrorReporter', () => {
  it('posts one event with the exception, stack frames and tags', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const report = createErrorReporter(DSN, { fetch, release: 'r1', environment: 'local' });
    const err = new TypeError('boom');

    await report(err, { correlationId: 'c-1', method: 'POST', path: '/v1/trips' });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/7/store/');
    expect((init.headers as Record<string, string>)['x-sentry-auth']).toContain('sentry_key=abc123');
    const event = JSON.parse(init.body as string);
    expect(event.platform).toBe('node');
    expect(event.release).toBe('r1');
    expect(event.environment).toBe('local');
    expect(event.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom' });
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(event.tags).toEqual({ correlationId: 'c-1', method: 'POST', path: '/v1/trips' });
  });

  it('reports a non-Error throw as its string form', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    await createErrorReporter(DSN, { fetch })('plain', {});
    const event = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'plain' });
  });

  it('never throws: a failing or slow transport is swallowed', async () => {
    const down = createErrorReporter(DSN, { fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(down(new Error('x'), {})).resolves.toBeUndefined();

    const hang = createErrorReporter(DSN, {
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    });
    await expect(hang(new Error('x'), {})).resolves.toBeUndefined();
  });
});
