import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './api-client.ts';
import { readConfig } from './config.ts';
import { createMcpServer } from './tools.ts';

/**
 * The ridecore MCP server over stdio. stdout carries only protocol frames: every message of ours goes
 * to stderr. Usage (README): RIDECORE_API_URL and RIDECORE_MCP_TOKEN (a passenger token) in the env.
 */
let config;
try {
  config = readConfig(process.env);
} catch (err) {
  console.error(`ridecore-mcp: ${(err as Error).message} (see README, "Use it from an AI agent")`);
  process.exit(1);
}

await createMcpServer(createApiClient(config)).connect(new StdioServerTransport());
console.error(`ridecore-mcp: ready, calling ${config.baseUrl}`);
