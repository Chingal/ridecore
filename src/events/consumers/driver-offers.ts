import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { createDocumentClient, createDynamoClient } from '../../infra/dynamo/client.ts';
import { ConsumedRepo } from '../../infra/dynamo/consumed-repo.ts';
import { tableNameFromEnv } from '../../infra/dynamo/keys.ts';
import { jsonLog, type Logger } from '../../log.ts';
import { driverOfferSchema } from '../envelope.ts';
import { fromRaw, sqsHandler } from '../sqs.ts';

export type DriverOffersConsumerDeps = {
  consumed: Pick<ConsumedRepo, 'markOnce'>;
  log: Logger;
  now?: () => Date;
};

/**
 * Driver offers from SNS (raw delivery). Records each `offerId` once and logs it; duplicates are
 * acked and logged as such. Plan 2b pushes the offer to the driver's socket here.
 */
export function createDriverOffersConsumer(deps: DriverOffersConsumerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const now = deps.now ?? (() => new Date());
  return sqsHandler(
    'driver-offers',
    fromRaw(driverOfferSchema),
    async (offer) => {
      const first = await deps.consumed.markOnce('driver-offers', offer.offerId, now());
      deps.log({
        level: 'info',
        msg: first ? 'offer received' : 'duplicate offer',
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
  lambda ??= createDriverOffersConsumer({
    consumed: new ConsumedRepo(createDocumentClient(createDynamoClient()), tableNameFromEnv()),
    log: jsonLog,
  });
  return lambda(event);
};
