import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { TripEvent } from '../../domain/events.ts';
import type { Actor } from '../../domain/trip.ts';
import { createDocumentClient, createDynamoClient } from '../../infra/dynamo/client.ts';
import { ConnectionRepo } from '../../infra/dynamo/connection-repo.ts';
import { tableNameFromEnv } from '../../infra/dynamo/keys.ts';
import { jsonLog, type Logger } from '../../log.ts';
import { tripMessage } from '../../realtime/messages.ts';
import { createApiGatewayPusher, type Pusher, sendToActor, wsManagementEndpoint } from '../../realtime/pusher.ts';
import { fromEventBridge, sqsHandler } from '../sqs.ts';

export type NotifierConsumerDeps = {
  connections: Pick<ConnectionRepo, 'byActor' | 'remove'>;
  pusher: Pusher;
  log: Logger;
};

/** The trip's participants named in the event: its passenger, and its driver once there is one. */
function recipients(event: TripEvent): Actor[] {
  const { passengerId, driverId } = event.payload;
  if (typeof passengerId !== 'string' || passengerId === '') throw new Error('event has no passengerId');
  const actors: Actor[] = [{ id: passengerId, role: 'passenger' }];
  if (typeof driverId === 'string' && driverId !== '') actors.push({ id: driverId, role: 'driver' });
  return actors;
}

/**
 * Every `trip.*` event → a `trip` push to the sockets of the trip's passenger and driver (ADR 0005).
 * Not deduplicated: each push carries the trip `version`, and clients drop anything not newer than
 * what they have. A push error other than a gone socket fails the message, so SQS retries it.
 */
export function createNotifierConsumer(deps: NotifierConsumerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return sqsHandler(
    'notifier',
    fromEventBridge,
    async (event) => {
      const message = tripMessage(event);
      for (const actor of recipients(event)) {
        await sendToActor(deps.pusher, deps.connections, actor, message);
      }
    },
    deps.log,
  );
}

let lambda: ((event: SQSEvent) => Promise<SQSBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/notifier.mjs`). */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => {
  lambda ??= createNotifierConsumer({
    connections: new ConnectionRepo(createDocumentClient(createDynamoClient()), tableNameFromEnv()),
    pusher: createApiGatewayPusher(wsManagementEndpoint()),
    log: jsonLog,
  });
  return lambda(event);
};
