import { readFileSync } from 'node:fs';

/**
 * CDK stack outputs (`cdk-outputs.json`) → the env variables osls, the e2e test and the scripts read.
 * The only place these names meet: CDK never reads anything back (one-way reference, ADR 0004).
 *
 *   node scripts/cdk-env.ts          # export lines from cdk-outputs.json (RidecoreStateful)
 *   node scripts/cdk-env.ts --dummy  # export lines with placeholder ARNs, for `serverless package`
 */
const MAPPING = {
  TableName: 'RIDECORE_TABLE',
  TableStreamArn: 'RIDECORE_TABLE_STREAM_ARN',
  EventBusName: 'RIDECORE_EVENT_BUS',
  OffersTopicArn: 'RIDECORE_OFFERS_TOPIC_ARN',
  DispatchQueueArn: 'RIDECORE_DISPATCH_QUEUE_ARN',
  BillingQueueArn: 'RIDECORE_BILLING_QUEUE_ARN',
  DriverOffersQueueArn: 'RIDECORE_DRIVER_OFFERS_QUEUE_ARN',
  DispatchQueueUrl: 'RIDECORE_DISPATCH_QUEUE_URL',
  BillingQueueUrl: 'RIDECORE_BILLING_QUEUE_URL',
  DriverOffersQueueUrl: 'RIDECORE_DRIVER_OFFERS_QUEUE_URL',
  DispatchDlqUrl: 'RIDECORE_DISPATCH_DLQ_URL',
  BillingDlqUrl: 'RIDECORE_BILLING_DLQ_URL',
  DriverOffersDlqUrl: 'RIDECORE_DRIVER_OFFERS_DLQ_URL',
  PublisherFailuresQueueArn: 'RIDECORE_PUBLISHER_FAILURES_QUEUE_ARN',
} as const;

const ACCOUNT = 'arn:aws:%s:us-east-1:000000000000:';
const arn = (service: string, rest: string) => ACCOUNT.replace('%s', service) + rest;
const url = (queue: string) => `https://sqs.us-east-1.amazonaws.com/000000000000/${queue}`;

/** Placeholder outputs: `serverless package` resolves every variable but deploys nothing. */
export const DUMMY_OUTPUTS: Record<keyof typeof MAPPING, string> = {
  TableName: 'ridecore',
  TableStreamArn: arn('dynamodb', 'table/ridecore/stream/package-only'),
  EventBusName: 'ridecore',
  OffersTopicArn: arn('sns', 'ridecore-driver-offers'),
  DispatchQueueArn: arn('sqs', 'ridecore-dispatch'),
  BillingQueueArn: arn('sqs', 'ridecore-billing'),
  DriverOffersQueueArn: arn('sqs', 'ridecore-driver-offers'),
  DispatchQueueUrl: url('ridecore-dispatch'),
  BillingQueueUrl: url('ridecore-billing'),
  DriverOffersQueueUrl: url('ridecore-driver-offers'),
  DispatchDlqUrl: url('ridecore-dispatch-dlq'),
  BillingDlqUrl: url('ridecore-billing-dlq'),
  DriverOffersDlqUrl: url('ridecore-driver-offers-dlq'),
  PublisherFailuresQueueArn: arn('sqs', 'ridecore-publisher-failures'),
};

export function cdkEnv(outputs: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [output, name] of Object.entries(MAPPING)) {
    const value = outputs[output];
    if (value === undefined || value === '') throw new Error(`CDK output ${output} is missing (run 'make deploy-stateful')`);
    env[name] = value;
  }
  return env;
}

export function shellExports(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
    .join('\n');
}

if (import.meta.main) {
  const outputs = process.argv.includes('--dummy')
    ? DUMMY_OUTPUTS
    : (JSON.parse(readFileSync('cdk-outputs.json', 'utf8')) as { RidecoreStateful: Record<string, string> }).RidecoreStateful;
  console.log(shellExports(cdkEnv(outputs)));
}
