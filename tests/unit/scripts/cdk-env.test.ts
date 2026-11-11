import { describe, expect, it } from 'vitest';
import { cdkEnv, DUMMY_OUTPUTS, shellExports } from '../../../scripts/cdk-env.ts';

const outputs = {
  TableName: 'ridecore',
  TableStreamArn: 'arn:aws:dynamodb:us-east-1:000000000000:table/ridecore/stream/1',
  EventBusName: 'ridecore',
  OffersTopicArn: 'arn:aws:sns:us-east-1:000000000000:ridecore-driver-offers',
  DispatchQueueArn: 'arn:aws:sqs:us-east-1:000000000000:ridecore-dispatch',
  BillingQueueArn: 'arn:aws:sqs:us-east-1:000000000000:ridecore-billing',
  DriverOffersQueueArn: 'arn:aws:sqs:us-east-1:000000000000:ridecore-driver-offers',
  DispatchQueueUrl: 'http://q/dispatch',
  BillingQueueUrl: 'http://q/billing',
  DriverOffersQueueUrl: 'http://q/driver-offers',
  DispatchDlqUrl: 'http://q/dispatch-dlq',
  BillingDlqUrl: 'http://q/billing-dlq',
  DriverOffersDlqUrl: 'http://q/driver-offers-dlq',
  PublisherFailuresQueueArn: 'arn:aws:sqs:us-east-1:000000000000:ridecore-publisher-failures',
  NotificationsQueueArn: 'arn:aws:sqs:us-east-1:000000000000:ridecore-notifications',
  NotificationsQueueUrl: 'http://q/notifications',
  NotificationsDlqUrl: 'http://q/notifications-dlq',
  LocationTripsQueueUrl: 'http://q/location-trips',
  LocationTripsDlqUrl: 'http://q/location-trips-dlq',
};

describe('cdkEnv', () => {
  it('maps every CDK output to the env variable the functions and scripts read', () => {
    expect(cdkEnv(outputs)).toEqual({
      RIDECORE_TABLE: 'ridecore',
      RIDECORE_TABLE_STREAM_ARN: outputs.TableStreamArn,
      RIDECORE_EVENT_BUS: 'ridecore',
      RIDECORE_OFFERS_TOPIC_ARN: outputs.OffersTopicArn,
      RIDECORE_DISPATCH_QUEUE_ARN: outputs.DispatchQueueArn,
      RIDECORE_BILLING_QUEUE_ARN: outputs.BillingQueueArn,
      RIDECORE_DRIVER_OFFERS_QUEUE_ARN: outputs.DriverOffersQueueArn,
      RIDECORE_DISPATCH_QUEUE_URL: 'http://q/dispatch',
      RIDECORE_BILLING_QUEUE_URL: 'http://q/billing',
      RIDECORE_DRIVER_OFFERS_QUEUE_URL: 'http://q/driver-offers',
      RIDECORE_DISPATCH_DLQ_URL: 'http://q/dispatch-dlq',
      RIDECORE_BILLING_DLQ_URL: 'http://q/billing-dlq',
      RIDECORE_DRIVER_OFFERS_DLQ_URL: 'http://q/driver-offers-dlq',
      RIDECORE_PUBLISHER_FAILURES_QUEUE_ARN: outputs.PublisherFailuresQueueArn,
      RIDECORE_NOTIFICATIONS_QUEUE_ARN: outputs.NotificationsQueueArn,
      RIDECORE_NOTIFICATIONS_QUEUE_URL: 'http://q/notifications',
      RIDECORE_NOTIFICATIONS_DLQ_URL: 'http://q/notifications-dlq',
      RIDECORE_LOCATION_TRIPS_QUEUE_URL: 'http://q/location-trips',
      RIDECORE_LOCATION_TRIPS_DLQ_URL: 'http://q/location-trips-dlq',
    });
  });

  it('fails naming the missing output instead of exporting an empty value', () => {
    const { BillingQueueArn: _missing, ...partial } = outputs;
    void _missing;
    expect(() => cdkEnv(partial)).toThrow('BillingQueueArn');
  });

  it('has dummy outputs for packaging without a deploy', () => {
    expect(Object.keys(cdkEnv(DUMMY_OUTPUTS))).toHaveLength(19);
  });
});

describe('shellExports', () => {
  it('prints single-quoted export lines, escaping quotes', () => {
    expect(shellExports({ A: "it's", B: 'x' })).toBe("export A='it'\\''s'\nexport B='x'");
  });
});
