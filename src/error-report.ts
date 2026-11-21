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
      tags: Object.fromEntries(
        Object.entries(context).flatMap(([k, v]) => (v === undefined ? [] : [[k, redact(v)]])),
      ),
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

const MAX_TEXT = 2048;

function dropTrailingTokenRun(text: string): string {
  let end = text.length;
  while (end > 0 && /[\w.-]/.test(text[end - 1] as string)) end--;
  return text.slice(0, end);
}
const MAX_FRAMES = 50;

type Frame = { function?: string; filename: string; lineno?: number; colno?: number; in_app: boolean };

/**
 * Bearer credentials and token-shaped strings (three base64url segments, the JWS compact form, with or
 * without the usual `eyJ` prefix) never leave the process, whatever field carries them.
 */
export function redact(text: string): string {
  // Bounded first: an error message can be huge, and nothing past this helps triage.
  // The cut can land inside a token, leaving a fragment the token pattern no longer matches, so the
  // token-character run touching the cut is dropped whole. A linear scan, not a regex, keeps it cheap.
  const bounded = text.length > MAX_TEXT ? `${dropTrailingTokenRun(text.slice(0, MAX_TEXT))}…[truncated]` : text;
  return bounded
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted]');
}

function exceptionOf(err: unknown) {
  if (!(err instanceof Error)) return { type: 'Error', value: redact(String(err)) };
  const frames = framesOf(stackFrames(err));
  return { type: redact(err.name), value: redact(err.message), ...(frames.length > 0 ? { stacktrace: { frames } } : {}) };
}

/**
 * The frame lines of a V8 stack: what follows the header. The header is `Name: message` or
 * `Name [CODE]: message` and the message may span lines, so it ends where the message ends.
 */
function stackFrames(err: Error): string {
  const stack = err.stack ?? '';
  if (err.message === '') return stack.slice(stack.indexOf('\n') + 1);
  const at = stack.indexOf(err.message);
  return at < 0 ? '' : stack.slice(at + err.message.length);
}

/** V8 frame lines → Sentry frames, oldest first (Sentry's order). Names and paths are redacted too. */
function framesOf(frameLines: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of frameLines.split('\n').slice(0, MAX_FRAMES)) {
    const m = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (m === null) continue;
    const [, rawFn, rawFile = '', lineno, colno] = m;
    const fn = rawFn === undefined ? undefined : redact(rawFn);
    const filename = redact(rawFile);
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
