import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDispatch, type Dispatch } from '../../app/dispatch.ts';
import { createDocumentClient, createDynamoClient } from '../../infra/dynamo/client.ts';
import { DriverRepo } from '../../infra/dynamo/driver-repo.ts';
import { tableNameFromEnv } from '../../infra/dynamo/keys.ts';
import { TripRepo } from '../../infra/dynamo/trip-repo.ts';
import { jsonLog, type Logger } from '../../log.ts';
import type { DriverOffer } from '../envelope.ts';
import { fromEventBridge, sqsHandler } from '../sqs.ts';

export type DispatchConsumerDeps = {
  dispatch: Pick<Dispatch, 'offerTripOnce'>;
  publish: (offer: DriverOffer) => Promise<void>;
  log: Logger;
  now?: () => Date;
};

/**
 * `trip.requested` → offer the trip once (ADR 0004) → one SNS message per offered driver. On a
 * redelivery the recorded offers are published again, so an SNS publish lost after the offers were
 * written is recovered; the driver-offers consumer dedups by `offerId`. Other event types are acked.
 */
export function createDispatchConsumer(deps: DispatchConsumerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const now = deps.now ?? (() => new Date());
  return sqsHandler(
    'dispatch',
    fromEventBridge,
    async (event) => {
      if (event.type !== 'trip.requested') return;
      const at = now();
      const { driverIds } = await deps.dispatch.offerTripOnce(event.tripId, at);
      for (const driverId of driverIds) {
        await deps.publish({
          schemaVersion: 1,
          offerId: `${event.tripId}:${driverId}`,
          tripId: event.tripId,
          driverId,
          offeredAt: at.toISOString(),
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        });
      }
    },
    deps.log,
  );
}

let lambda: ((event: SQSEvent) => Promise<SQSBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/dispatch.mjs`). */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => {
  if (lambda === undefined) {
    const doc = createDocumentClient(createDynamoClient());
    const table = tableNameFromEnv();
    const sns = new SNSClient({});
    const topicArn = process.env.RIDECORE_OFFERS_TOPIC_ARN;
    if (topicArn === undefined || topicArn === '') throw new Error('RIDECORE_OFFERS_TOPIC_ARN is not set');
    lambda = createDispatchConsumer({
      dispatch: createDispatch({ trips: new TripRepo(doc, table), drivers: new DriverRepo(doc, table) }),
      publish: async (offer) => {
        await sns.send(new PublishCommand({ TopicArn: topicArn, Message: JSON.stringify(offer) }));
      },
      log: jsonLog,
    });
  }
  return lambda(event);
};
