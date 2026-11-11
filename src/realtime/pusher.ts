import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { Actor } from '../domain/trip.ts';
import type { ConnectionRepo } from '../infra/dynamo/connection-repo.ts';
import type { ServerMessage } from './messages.ts';

/** Sends one message to one socket; `'gone'` when the socket no longer exists (410). */
export interface Pusher {
  send(connectionId: string, message: ServerMessage): Promise<'sent' | 'gone'>;
}

type Sender = { send(command: PostToConnectionCommand): Promise<unknown> };

/** PostToConnection on the WebSocket API's management endpoint (`wsManagementEndpoint`). */
export function createApiGatewayPusher(endpoint: string, client: Sender = new ApiGatewayManagementApiClient({ endpoint })): Pusher {
  return {
    async send(connectionId, message) {
      try {
        await client.send(
          new PostToConnectionCommand({ ConnectionId: connectionId, Data: new TextEncoder().encode(JSON.stringify(message)) }),
        );
        return 'sent';
      } catch (err) {
        if (err instanceof Error && err.name === 'GoneException') return 'gone';
        throw err;
      }
    },
  };
}

/**
 * The management endpoint of the WebSocket API (ADR 0005): on Floci (`AWS_ENDPOINT_URL` set) the
 * API's subdomain of that host, on AWS the regional execute-api host. Fails when the id or stage is unset.
 */
export function wsManagementEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const apiId = env.RIDECORE_WS_API_ID;
  const stage = env.RIDECORE_WS_STAGE;
  if (!apiId || !stage) throw new Error('RIDECORE_WS_API_ID and RIDECORE_WS_STAGE must be set');
  if (env.AWS_ENDPOINT_URL) {
    const url = new URL(env.AWS_ENDPOINT_URL);
    return `${url.protocol}//${apiId}.execute-api.${url.host}/${stage}`;
  }
  return `https://${apiId}.execute-api.${env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${stage}`;
}

export type SendResult = { sent: number; gone: number };

/**
 * Sends `message` to every id in parallel and removes the sockets that are gone. Any other error is
 * rethrown after every send settled, so the caller's message is retried (pushes are at-least-once).
 */
export async function sendToConnections(
  pusher: Pusher,
  connections: Pick<ConnectionRepo, 'remove'>,
  ids: readonly string[],
  message: ServerMessage,
): Promise<SendResult> {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const outcome = await pusher.send(id, message);
      if (outcome === 'gone') await connections.remove(id);
      return outcome;
    }),
  );
  const failed = results.find((r) => r.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  const outcomes = results.map((r) => (r as PromiseFulfilledResult<'sent' | 'gone'>).value);
  return { sent: outcomes.filter((o) => o === 'sent').length, gone: outcomes.filter((o) => o === 'gone').length };
}

/** Sends `message` to every open socket of `actor`. */
export async function sendToActor(
  pusher: Pusher,
  connections: Pick<ConnectionRepo, 'byActor' | 'remove'>,
  actor: Actor,
  message: ServerMessage,
): Promise<SendResult> {
  return sendToConnections(pusher, connections, await connections.byActor(actor), message);
}
