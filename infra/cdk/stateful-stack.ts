import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { SqsQueue } from 'aws-cdk-lib/aws-events-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { TABLE_DEFINITION, tableNameFromEnv } from '../../src/infra/dynamo/keys.ts';

export interface StatefulStackProps extends StackProps {
  tableName?: string;
}

/** Names shared with the functions, the scripts and the docs (Plan 2a, ADR 0004). */
export const EVENT_BUS_NAME = 'ridecore';
export const EVENT_SOURCE = 'ridecore.trips';
export const OFFERS_TOPIC_NAME = 'ridecore-driver-offers';

/** 6 x the 10 s Lambda timeout, so a message is never visible again while a consumer still runs. */
const VISIBILITY_TIMEOUT = Duration.seconds(60);
const MAX_RECEIVES = 3;
const DLQ_RETENTION = Duration.days(14);

/**
 * Long-lived resources: the single ridecore table (trips, active reservations, outbox events) and the
 * event path (bus, rules, consumer queues with DLQs, the driver-offers topic). Functions live in osls
 * and read these through the outputs, one way only.
 */
export class StatefulStack extends Stack {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: StatefulStackProps = {}) {
    super(scope, id, props);
    const def = TABLE_DEFINITION;

    this.table = new Table(this, 'Table', {
      tableName: props.tableName ?? tableNameFromEnv(),
      partitionKey: { name: def.partitionKey, type: AttributeType.STRING },
      sortKey: { name: def.sortKey, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType[def.streamViewType],
      timeToLiveAttribute: def.timeToLiveAttribute,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const gsi of def.globalSecondaryIndexes) {
      this.table.addGlobalSecondaryIndex({
        indexName: gsi.indexName,
        partitionKey: { name: gsi.partitionKey, type: AttributeType.STRING },
        sortKey: { name: gsi.sortKey, type: AttributeType.STRING },
        projectionType: ProjectionType.ALL,
      });
    }

    const bus = new EventBus(this, 'EventBus', { eventBusName: EVENT_BUS_NAME });
    const consumerQueue = (id: string, name: string) => {
      const dlq = new Queue(this, `${id}Dlq`, { queueName: `${name}-dlq`, retentionPeriod: DLQ_RETENTION });
      const queue = new Queue(this, `${id}Queue`, {
        queueName: name,
        visibilityTimeout: VISIBILITY_TIMEOUT,
        deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVES },
      });
      new CfnOutput(this, `${id}QueueArn`, { value: queue.queueArn });
      new CfnOutput(this, `${id}QueueUrl`, { value: queue.queueUrl });
      new CfnOutput(this, `${id}DlqUrl`, { value: dlq.queueUrl });
      return queue;
    };
    const dispatch = consumerQueue('Dispatch', 'ridecore-dispatch');
    const billing = consumerQueue('Billing', 'ridecore-billing');
    const driverOffers = consumerQueue('DriverOffers', 'ridecore-driver-offers');

    const route = (id: string, type: string, queue: Queue) =>
      new Rule(this, id, {
        eventBus: bus,
        eventPattern: { source: [EVENT_SOURCE], detailType: [type] },
        targets: [new SqsQueue(queue)],
      });
    route('TripRequestedToDispatch', 'trip.requested', dispatch);
    route('TripCompletedToBilling', 'trip.completed', billing);

    const offers = new Topic(this, 'OffersTopic', { topicName: OFFERS_TOPIC_NAME });
    offers.addSubscription(new SqsSubscription(driverOffers, { rawMessageDelivery: true }));

    new CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new CfnOutput(this, 'OffersTopicArn', { value: offers.topicArn });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'TableStreamArn', { value: this.table.tableStreamArn ?? '' });
  }
}
