/**
 * Optional error reporting to any Sentry-protocol server (Sentry, GlitchTip) without an SDK dependency.
 * Off unless `SENTRY_DSN` is set, so deployments without it behave exactly as before. Only unexpected
 * failures (5xx) are reported; domain errors are the API's normal answers, not bugs.
 */

export type ErrorContext = Record<string, string | undefined>;
/** Sends one error; never throws and gives up after `timeoutMs`, so it cannot break or stall a request. */
export type ErrorReporter = (err: unknown, context: ErrorContext) => Promise<void>;

export type ReporterOptions = {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  release?: string;
  environment?: string;
};

export type ParsedDsn = { storeUrl: string; publicKey: string; secretKey?: string };

/** `http(s)://key[:secret]@host[/prefix]/project` → store endpoint and keys. Errors never echo the DSN. */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('SENTRY_DSN is not a valid DSN');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const project = parts.pop();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('SENTRY_DSN is not a valid DSN');
  if (!url.username || project === undefined || !/^\d+$/.test(project)) throw new Error('SENTRY_DSN is not a valid DSN');
  const prefix = parts.length > 0 ? `/${parts.join('/')}` : '';
  return {
    storeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/store/`,
    publicKey: decodeURIComponent(url.username),
    ...(url.password ? { secretKey: decodeURIComponent(url.password) } : {}),
  };
}

/**
 * The reporter from `SENTRY_DSN`, or undefined (reporting off) when it is unset or blank. A malformed
 * DSN also turns reporting off, with a warning that never contains the DSN: optional telemetry must
 * not stop the API from starting.
 */
export function errorReporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => console.warn(JSON.stringify({ level: 'warn', msg: message })),
): ErrorReporter | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  try {
    return createErrorReporter(dsn, {
      ...(env.SENTRY_RELEASE ? { release: env.SENTRY_RELEASE } : {}),
      ...(env.SENTRY_ENVIRONMENT ? { environment: env.SENTRY_ENVIRONMENT } : {}),
    });
  } catch {
    warn('SENTRY_DSN is not a valid DSN; error reporting is off');
    return undefined;
  }
}

export function createErrorReporter(dsn: string, opts: ReporterOptions = {}): ErrorReporter {
  const { storeUrl, publicKey, secretKey } = parseDsn(dsn);
  const send = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 1000;
  const secret = secretKey === undefined ? '' : `, sentry_secret=${secretKey}`;
  const auth = `Sentry sentry_version=7, sentry_key=${publicKey}${secret}, sentry_client=ridecore/1`;

  return async (err, context) => {
    const event = {
      event_id: crypto.randomUUID().replaceAll('-', ''),
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      ...(opts.release ? { release: opts.release } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
      exception: { values: [exceptionOf(err)] },
      tags: Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined)),
    };
    try {
      await send(storeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sentry-auth': auth },
        body: JSON.stringify(event),
        // A redirect would carry the event and the key to another origin.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Reporting is best effort: the request already has its 500 answer and its log line.
    }
  };
}

type Frame = { function?: string; filename: string; lineno?: number; colno?: number; in_app: boolean };

/** Bearer credentials and JWT-shaped strings never leave the process, whatever message carries them. */
export function redact(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]');
}

function exceptionOf(err: unknown) {
  if (!(err instanceof Error)) return { type: 'Error', value: redact(String(err)) };
  const frames = framesOf(err.stack);
  return { type: err.name, value: redact(err.message), ...(frames.length > 0 ? { stacktrace: { frames } } : {}) };
}

/** V8 stack lines → Sentry frames, oldest first (Sentry's order). */
function framesOf(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const m = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (m === null) continue;
    const [, fn, filename = '', lineno, colno] = m;
    frames.push({
      ...(fn ? { function: fn } : {}),
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}
