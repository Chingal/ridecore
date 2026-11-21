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
    for (const bad of ['http://localhost:8000/7', 'http://k@localhost:8000/', 'not a url', 'ftp://k@collector.example/7']) {
      expect(() => parseDsn(bad)).toThrow('SENTRY_DSN is not a valid DSN');
      expect(() => parseDsn(bad)).not.toThrow(bad);
    }
  });
});

describe('parseDsn legacy secret', () => {
  it('keeps a legacy key:secret pair for older collectors', () => {
    expect(parseDsn('https://k:s@errors.example.com/3')).toMatchObject({ publicKey: 'k', secretKey: 's' });
  });
});

describe('errorReporterFromEnv', () => {
  it('turns reporting off (does not throw) on a malformed DSN, and warns without echoing it', () => {
    const warn = vi.fn();
    expect(errorReporterFromEnv({ SENTRY_DSN: 'not-a-dsn-secret' }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-a-dsn-secret');
  });

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

  it('refuses redirects, so the event and key never reach another origin', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    await createErrorReporter(DSN, { fetch })(new Error('x'), {});
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
  });

  it('redacts bearer tokens and JWTs from the message', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwLTEifQ.c2lnbmF0dXJlLXZhbHVl';
    await createErrorReporter(DSN, { fetch })(new Error(`failed for Bearer ${jwt} and ${jwt}`), {});
    const event = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(JSON.stringify(event)).not.toContain(jwt);
    expect(event.exception.values[0].value).toContain('[redacted]');
  });

  it('parses anonymous async frames without the "async " prefix in the filename', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const err = new Error('x');
    err.stack = 'Error: x\n    at async file:///app/src/a.ts:40:3\n    at async run (file:///app/src/b.ts:7:9)';
    await createErrorReporter(DSN, { fetch })(err, {});
    const event = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const files = event.exception.values[0].stacktrace.frames.map((f: { filename: string }) => f.filename);
    expect(files).toEqual(['file:///app/src/b.ts', 'file:///app/src/a.ts']);
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
