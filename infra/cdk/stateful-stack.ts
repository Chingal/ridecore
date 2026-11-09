import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { TABLE_DEFINITION, tableNameFromEnv } from '../../src/infra/dynamo/keys.ts';

export interface StatefulStackProps extends StackProps {
  tableName?: string;
}

/** Long-lived resources: the single ridecore table (trips, active reservations, outbox events). */
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

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'TableStreamArn', { value: this.table.tableStreamArn ?? '' });
  }
}
