import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { StatefulStack } from './stateful-stack.ts';

describe('StatefulStack', () => {
  const template = Template.fromStack(new StatefulStack(new App(), 'T'));

  it('defines exactly one DynamoDB table with keys, GSIs, stream, TTL and on-demand billing', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'ridecore',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('declares all key attributes as strings', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const [table] = Object.values(tables);
    const defs = (table?.Properties as { AttributeDefinitions: { AttributeName: string; AttributeType: string }[] })
      .AttributeDefinitions;
    expect(defs.map((d) => d.AttributeName).sort()).toEqual(['GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'PK', 'SK']);
    expect(defs.every((d) => d.AttributeType === 'S')).toBe(true);
  });

  it('outputs the table name and stream ARN', () => {
    template.hasOutput('TableName', {});
    template.hasOutput('TableStreamArn', {});
  });
});
