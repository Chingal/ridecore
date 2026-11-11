export type McpConfig = { baseUrl: string; token: string };

/**
 * The MCP server's settings: the HTTP API to call and the one passenger token it acts with.
 * Errors name the variable, never its value.
 */
export function readConfig(env: NodeJS.ProcessEnv): McpConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  const baseUrl = required('RIDECORE_API_URL');
  const token = required('RIDECORE_MCP_TOKEN');
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    throw new Error('RIDECORE_API_URL is not a valid URL');
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error('RIDECORE_API_URL must be an http or https URL');
  return { baseUrl, token };
}
