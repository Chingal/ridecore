import { depsFromEnv } from './deps.ts';
import { type ApiHandler, createHandler } from './handler.ts';

/**
 * Lambda entry point (API Gateway HTTP API v2). Dependencies are built from env at module init (cold
 * start), so a missing table name or a missing/short JWT secret fails the function's initialization
 * instead of serving requests.
 */
export const handler: ApiHandler = createHandler(depsFromEnv());
