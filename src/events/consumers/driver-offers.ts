import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDocumentClient, createDynamoClient } from '../../infra/dynamo/client.ts';
import { ConnectionRepo } from '../../infra/dynamo/connection-repo.ts';
import { ConsumedRepo } from '../../infra/dynamo/consumed-repo.ts';
import { tableNameFromEnv } from '../../infra/dynamo/keys.ts';
import { jsonLog, type Logger } from '../../log.ts';
import { createApiGatewayPusher, type Pusher, sendToActor, wsManagementEndpoint } from '../../realtime/pusher.ts';
import { driverOfferSchema } from '../envelope.ts';
import { fromRaw, sqsHandler } from '../sqs.ts';

export type DriverOffersConsumerDeps = {
  consumed: Pick<ConsumedRepo, 'has' | 'markOnce'>;
  connections: Pick<ConnectionRepo, 'byActor' | 'remove'>;
  pusher: Pusher;
  log: Logger;
  now?: () => Date;
};

/**
 * Driver offers from SNS (raw delivery). The first delivery of an `offerId` is pushed to the driver's
 * sockets and then recorded; a failed push leaves it unrecorded, so the SQS retry pushes it again.
 * Recorded offers are acked as duplicates. Two concurrent first deliveries may both push (harmless:
 * the client keys offers by `offerId`, ADR 0005).
 */
export function createDriverOffersConsumer(deps: DriverOffersConsumerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const now = deps.now ?? (() => new Date());
  return sqsHandler(
    'driver-offers',
    fromRaw(driverOfferSchema),
    async (offer) => {
      const duplicate = await deps.consumed.has('driver-offers', offer.offerId);
      if (!duplicate) {
        const { offerId, tripId, offeredAt } = offer;
        await sendToActor(deps.pusher, deps.connections, { id: offer.driverId, role: 'driver' }, {
          type: 'offer',
          schemaVersion: 1,
          offer: { offerId, tripId, offeredAt },
        });
        await deps.consumed.markOnce('driver-offers', offer.offerId, now());
      }
      deps.log({
        level: 'info',
        msg: duplicate ? 'duplicate offer' : 'offer received',
        consumer: 'driver-offers',
        tripId: offer.tripId,
        driverId: offer.driverId,
        ...(offer.correlationId === undefined ? {} : { correlationId: offer.correlationId }),
      });
    },
    deps.log,
  );
}

let lambda: ((event: SQSEvent) => Promise<SQSBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/driver-offers.mjs`). */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => {
  if (lambda === undefined) {
    const doc = createDocumentClient(createDynamoClient());
    const table = tableNameFromEnv();
    lambda = createDriverOffersConsumer({
      consumed: new ConsumedRepo(doc, table),
      connections: new ConnectionRepo(doc, table),
      pusher: createApiGatewayPusher(wsManagementEndpoint()),
      log: jsonLog,
    });
  }
  return lambda(event);
};
