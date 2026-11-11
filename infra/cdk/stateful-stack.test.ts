import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it, vi } from 'vitest';
import { StatefulStack } from './stateful-stack.ts';

describe('StatefulStack', () => {
  vi.stubEnv('RIDECORE_TABLE', undefined); // default table name, regardless of the caller's env
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

  it('defines the ridecore event bus', () => {
    template.resourceCountIs('AWS::Events::EventBus', 1);
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'ridecore' });
  });

  it('defines each consumer queue with a DLQ: 3 receives, 60 s visibility, 14-day DLQ retention', () => {
    template.resourceCountIs('AWS::SQS::Queue', 9);
    for (const name of ['ridecore-dispatch', 'ridecore-billing', 'ridecore-driver-offers', 'ridecore-notifications']) {
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: `${name}-dlq`, MessageRetentionPeriod: 1209600 });
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: name,
        VisibilityTimeout: 60,
        RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 3 },
      });
    }
  });

  it('routes trip.requested to the dispatch queue and trip.completed to the billing queue', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')).map(
      (r) => r.Properties as { EventPattern: unknown; Targets: { Arn: unknown }[] },
    );
    expect(rules).toHaveLength(3);
    const targetOf = (type: string) => {
      const rule = rules.find((r) => JSON.stringify(r.EventPattern) === JSON.stringify({ source: ['ridecore.trips'], 'detail-type': [type] }));
      expect(rule, type).toBeDefined();
      return JSON.stringify(rule?.Targets);
    };
    expect(targetOf('trip.requested')).toContain('DispatchQueue');
    expect(targetOf('trip.completed')).toContain('BillingQueue');
  });

  it('routes every trip event (source only, any detail-type) to the notifications queue', () => {
    const rules = Object.values(template.findResources('AWS::Events::Rule')).map(
      (r) => r.Properties as { EventPattern: unknown; EventBusName: unknown; Targets: { Arn: unknown }[] },
    );
    const all = rules.filter((r) => JSON.stringify(r.EventPattern) === JSON.stringify({ source: ['ridecore.trips'] }));
    expect(all).toHaveLength(1);
    expect(JSON.stringify(all[0]?.Targets)).toContain('NotificationsQueue');
    expect(JSON.stringify(all[0]?.EventBusName)).toContain('EventBus');
  });

  it('fans driver offers out from an SNS topic to the driver-offers queue as raw messages', () => {
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'ridecore-driver-offers' });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      RawMessageDelivery: true,
      Endpoint: { 'Fn::GetAtt': [Match.stringLikeRegexp('^DriverOffersQueue'), 'Arn'] },
    });
  });

  it('keeps stream records the publisher could not deliver in a 14-day failure queue', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'ridecore-publisher-failures', MessageRetentionPeriod: 1209600 });
    template.hasOutput('PublisherFailuresQueueArn', {});
  });

  it('outputs everything the functions and scripts read', () => {
    for (const name of [
      'EventBusName',
      'DispatchQueueArn',
      'BillingQueueArn',
      'DriverOffersQueueArn',
      'DispatchQueueUrl',
      'BillingQueueUrl',
      'DriverOffersQueueUrl',
      'DispatchDlqUrl',
      'BillingDlqUrl',
      'DriverOffersDlqUrl',
      'OffersTopicArn',
      'NotificationsQueueArn',
      'NotificationsQueueUrl',
      'NotificationsDlqUrl',
    ]) {
      template.hasOutput(name, {});
    }
  });

  it('outputs the table name and stream ARN', () => {
    template.hasOutput('TableName', {});
    template.hasOutput('TableStreamArn', {});
  });
});
