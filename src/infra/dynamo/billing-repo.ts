import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { TripEvent } from '../../domain/events.ts';
import type { ConsumedRepo } from './consumed-repo.ts';
import { billingKey } from './keys.ts';

export type BillingRecord = {
  tripId: string;
  passengerId: string;
  driverId: string;
  finalFare: number;
  completedAt: string;
  eventId: string;
};

export const BILLING_CONSUMER = 'billing';

function field<T>(payload: Record<string, unknown>, name: string, check: (v: unknown) => v is T): T {
  const value = payload[name];
  if (!check(value)) throw new Error(`trip.completed event without a valid ${name}`);
  return value;
}
const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isFare = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Billing records of completed trips; one per trip, written once per event. */
export class BillingRepo {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly consumed: ConsumedRepo;

  constructor(doc: DynamoDBDocumentClient, tableName: string, consumed: ConsumedRepo) {
    this.doc = doc;
    this.tableName = tableName;
    this.consumed = consumed;
  }

  /**
   * Writes the billing record and the consumer's dedup record in ONE transaction, so the effect and
   * "already applied" can never disagree. A failed condition on either (the event, or the trip's
   * record, was already written) means a duplicate delivery.
   */
  async record(event: TripEvent, now: Date): Promise<'recorded' | 'duplicate'> {
    const record: BillingRecord = {
      tripId: event.tripId,
      passengerId: field(event.payload, 'passengerId', isString),
      driverId: field(event.payload, 'driverId', isString),
      finalFare: field(event.payload, 'finalFare', isFare),
      completedAt: event.occurredAt,
      eventId: event.eventId,
    };
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            this.consumed.putItem(BILLING_CONSUMER, event.eventId, now),
            {
              Put: {
                TableName: this.tableName,
                Item: { ...billingKey(event.tripId), entity: 'BILLING', ...record },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
      return 'recorded';
    } catch (err) {
      const reasons = err instanceof TransactionCanceledException ? (err.CancellationReasons ?? []) : [];
      if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) return 'duplicate';
      throw err;
    }
  }

  async get(tripId: string): Promise<BillingRecord | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: billingKey(tripId), ConsistentRead: true }));
    if (res.Item === undefined) return null;
    const { tripId: id, passengerId, driverId, finalFare, completedAt, eventId } = res.Item as BillingRecord;
    return { tripId: id, passengerId, driverId, finalFare, completedAt, eventId };
  }
}
