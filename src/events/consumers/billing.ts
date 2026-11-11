import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { BillingRepo } from '../../infra/dynamo/billing-repo.ts';
import { createDocumentClient, createDynamoClient } from '../../infra/dynamo/client.ts';
import { ConsumedRepo } from '../../infra/dynamo/consumed-repo.ts';
import { tableNameFromEnv } from '../../infra/dynamo/keys.ts';
import { jsonLog, type Logger } from '../../log.ts';
import { fromEventBridge, sqsHandler } from '../sqs.ts';

export type BillingConsumerDeps = { billing: Pick<BillingRepo, 'record'>; log: Logger; now?: () => Date };

/** `trip.completed` → one billing record per trip (idempotent per event); other types are acked. */
export function createBillingConsumer(deps: BillingConsumerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
  const now = deps.now ?? (() => new Date());
  return sqsHandler(
    'billing',
    fromEventBridge,
    async (event) => {
      if (event.type !== 'trip.completed') return;
      const outcome = await deps.billing.record(event, now());
      deps.log({
        level: 'info',
        msg: outcome === 'recorded' ? 'billing recorded' : 'duplicate billing event',
        consumer: 'billing',
        tripId: event.tripId,
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      });
    },
    deps.log,
  );
}

let lambda: ((event: SQSEvent) => Promise<SQSBatchResponse>) | undefined;

/** Lambda entry point (bundled to `dist/billing.mjs`). */
export const handler = (event: SQSEvent): Promise<SQSBatchResponse> => {
  if (lambda === undefined) {
    const doc = createDocumentClient(createDynamoClient());
    const table = tableNameFromEnv();
    lambda = createBillingConsumer({ billing: new BillingRepo(doc, table, new ConsumedRepo(doc, table)), log: jsonLog });
  }
  return lambda(event);
};
