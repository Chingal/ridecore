import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import type { ZodType } from 'zod';
import type { TripEvent } from '../domain/events.ts';
import { jsonLog, type Logger, type LogLine } from '../log.ts';
import { tripEventSchema } from './envelope.ts';

/** Parses an EventBridge envelope (SQS body of a rule target) and validates its `detail` as a TripEvent v1. */
export function fromEventBridge(body: string): TripEvent {
  const envelope = JSON.parse(body) as { detail?: unknown };
  return tripEventSchema.parse(envelope.detail);
}

/** Parses a raw JSON body (SNS raw delivery) with `schema`. */
export function fromRaw<T>(schema: ZodType<T>): (body: string) => T {
  return (body) => schema.parse(JSON.parse(body));
}

const correlationOf = (message: unknown): string | undefined => {
  const value = (message as { correlationId?: unknown } | null)?.correlationId;
  return typeof value === 'string' ? value : undefined;
};

/**
 * SQS consumer: parses and handles each record in order, one at a time. A record that cannot be
 * parsed or whose handling throws is reported in `batchItemFailures`, so only it is retried (and
 * after 3 receives it moves to the DLQ); the rest of the batch is acknowledged. One log line per
 * record; the raw body is never logged (a parse error message could quote it).
 */
export function sqsHandler<T>(
  name: string,
  parse: (body: string) => T,
  handle: (message: T) => Promise<void>,
  log: Logger = jsonLog,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const line: LogLine = { level: 'info', msg: 'message handled', consumer: name, messageId: record.messageId };
      let message: T;
      try {
        message = parse(record.body);
      } catch {
        log({ ...line, level: 'error', msg: 'message rejected', error: 'invalid message' });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      const correlationId = correlationOf(message);
      if (correlationId !== undefined) line.correlationId = correlationId;
      try {
        await handle(message);
        log(line);
      } catch (err) {
        log({ ...line, level: 'error', msg: 'message failed', error: err instanceof Error ? err.message : String(err) });
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
