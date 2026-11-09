import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { depsFromEnv } from '../http/deps.ts';
import { type ApiHandler, createHandler, handler } from '../http/handler.ts';
import { INTERNAL_MESSAGE } from '../http/respond.ts';
import { matchRoute } from '../http/routes.ts';

/**
 * Local HTTP adapter for fast development: translates a Node request into the API Gateway HTTP API
 * (payload v2) event the Lambda receives and writes the handler's result back. Same handler, same
 * route table; only the transport differs from the Floci/AWS deployment.
 */
export function toEvent(req: http.IncomingMessage, body: Buffer): APIGatewayProxyEventV2 {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  const match = matchRoute(method, url.pathname);
  const now = new Date();
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    ...(match === null || Object.keys(match.params).length === 0 ? {} : { pathParameters: match.params }),
    requestContext: {
      accountId: '000000000000',
      apiId: 'local',
      domainName: headers.host ?? 'localhost',
      domainPrefix: 'localhost',
      http: {
        method,
        path: url.pathname,
        protocol: `HTTP/${req.httpVersion}`,
        sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: now.toISOString(),
      timeEpoch: now.getTime(),
    },
    isBase64Encoded: false,
    ...(body.length === 0 ? {} : { body: body.toString('utf8') }),
  };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the adapter on `port` (0 picks a free one). Resolves once it is listening. */
export function startLocalServer(port = 3000, api: ApiHandler = handler): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    readBody(req)
      .then((body) => api(toEvent(req, body)))
      .then((out) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(out.headers ?? {})) headers[name] = String(value);
        res.writeHead(out.statusCode ?? 200, headers);
        res.end(out.body ?? '');
      })
      .catch((err: unknown) => {
        // The handler maps every error itself; this only fires on a transport failure.
        console.error(JSON.stringify({ level: 'error', msg: 'local adapter failure', error: String(err) }));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  // Build the dependencies now, so a missing table name or JWT secret stops the server at startup.
  const server = await startLocalServer(port, createHandler(depsFromEnv()));
  console.log(JSON.stringify({ level: 'info', msg: 'local API listening', url: `http://localhost:${port}` }));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
