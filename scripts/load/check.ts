import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { isActive, type Trip } from '../../src/domain/trip.ts';
import { BillingRepo } from '../../src/infra/dynamo/billing-repo.ts';
import { ConsumedRepo } from '../../src/infra/dynamo/consumed-repo.ts';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { DriverRepo } from '../../src/infra/dynamo/driver-repo.ts';
import { GSI1, passengerGsi1Pk, tripKey, type ReservationKind } from '../../src/infra/dynamo/keys.ts';
import { TripRepo } from '../../src/infra/dynamo/trip-repo.ts';
import { ACTORS_FILE, type ActorsFile } from './actors.ts';

/**
 * Invariant checker for after a load run (docs/load-testing.md). It reads the load actors' trips,
 * reservations, drivers, billing records, outbox events and the queues, and lists every
 * inconsistency. Reading nothing is a failure, not a pass.
 */
export type Snapshot = {
  trips: Trip[];
  reservations: { kind: ReservationKind; id: string; tripId: string | null }[];
  drivers: { id: string; availability: string | null }[];
  billed: Set<string>;
  eventVersions: Map<string, number[]>;
  queues: { name: string; visible: number; inFlight: number; dlq: boolean }[];
  /** DLQ depths recorded before the run (`check.ts baseline`): older messages are not this run's. */
  baselineDlq: Record<string, number>;
};

export type CheckResult = { read: { trips: number; drivers: number; queues: number }; violations: string[] };

export function evaluate(s: Snapshot): string[] {
  const v: string[] = [];
  const byId = new Map(s.trips.map((t) => [t.id, t]));
  const reservation = (kind: ReservationKind, id: string) => s.reservations.find((r) => r.kind === kind && r.id === id)?.tripId ?? null;

  // 1. Reservations and active trips agree, both ways.
  for (const r of s.reservations) {
    if (r.tripId === null) continue;
    const t = byId.get(r.tripId);
    const owner = t === undefined ? undefined : r.kind === 'PASSENGER' ? t.passengerId : t.driverId;
    if (t === undefined) v.push(`reservation ${r.kind}#${r.id} points to trip ${r.tripId}, which does not exist`);
    else if (!isActive(t.state)) v.push(`reservation ${r.kind}#${r.id} points to trip ${t.id} in state ${t.state}`);
    else if (owner !== r.id) v.push(`reservation ${r.kind}#${r.id} points to trip ${t.id} of ${owner ?? 'no driver'}`);
  }
  for (const t of s.trips) {
    if (!isActive(t.state)) continue;
    if (reservation('PASSENGER', t.passengerId) !== t.id) v.push(`active trip ${t.id} has no PASSENGER reservation for ${t.passengerId}`);
    if (t.driverId !== undefined && reservation('DRIVER', t.driverId) !== t.id) v.push(`active trip ${t.id} has no DRIVER reservation for ${t.driverId}`);
  }
  // 2. Every finished trip was billed.
  for (const t of s.trips) {
    if ((t.state === 'COMPLETED' || t.state === 'RATED') && !s.billed.has(t.id)) v.push(`trip ${t.id} is ${t.state} but has no billing record`);
  }
  // 3. No driver is stuck ON_TRIP.
  for (const d of s.drivers) {
    if (d.availability !== 'ON_TRIP') continue;
    const tripId = reservation('DRIVER', d.id);
    const t = tripId === null ? undefined : byId.get(tripId);
    if (t === undefined || !isActive(t.state)) v.push(`driver ${d.id} is ON_TRIP without an active trip`);
  }
  // 4. Each trip's outbox events are versions 1..N, N being the trip's version.
  for (const t of s.trips) {
    const got = [...(s.eventVersions.get(t.id) ?? [])].sort((a, b) => a - b);
    const ok = got.length === t.version && got.every((n, i) => n === i + 1);
    if (!ok) v.push(`trip ${t.id} has events [${got.join(',')}] for version ${t.version} (expected 1..${t.version})`);
  }
  // 5. Queues drained; DLQs did not grow.
  for (const q of s.queues) {
    if (q.dlq) {
      const before = s.baselineDlq[q.name] ?? 0;
      const now = q.visible + q.inFlight;
      if (now > before) v.push(`DLQ ${q.name} has ${now - before} new message(s) (${now} now, ${before} before the run)`);
    } else if (q.visible + q.inFlight > 0) {
      v.push(`queue ${q.name} did not drain: ${q.visible} visible, ${q.inFlight} in flight`);
    }
  }
  return v;
}

/** Main queues and DLQs read by invariant 5: dispatch, billing, driver-offers, notifications, each with its DLQ. */
export const QUEUE_COUNT = 8;

/** Any violation fails, and so does a check that skipped a part: no trips, no drivers, or missing queues. */
export function exitCode(result: CheckResult): 0 | 1 {
  const { trips, drivers, queues } = result.read;
  return result.violations.length > 0 || trips === 0 || drivers === 0 || queues < QUEUE_COUNT ? 1 : 0;
}

// ---------------------------------------------------------------- reading Floci

const QUEUES = ['DISPATCH', 'BILLING', 'DRIVER_OFFERS', 'NOTIFICATIONS'] as const;
const BASELINE_FILE = '.load/baseline.json';
/** Written before k6 starts: the run's start (trips older than it are not this run's) and the DLQ depths. */
type Baseline = { startedAt: string; dlq: Record<string, number> };
const DRAIN_WAIT_MS = 60_000;

function queueUrls(env: NodeJS.ProcessEnv): { name: string; url: string; dlq: boolean }[] {
  return QUEUES.flatMap((q) => {
    const name = q.toLowerCase().replace('_', '-');
    const main = env[`RIDECORE_${q}_QUEUE_URL`];
    const dlq = env[`RIDECORE_${q}_DLQ_URL`];
    return [
      ...(main ? [{ name, url: main, dlq: false }] : []),
      ...(dlq ? [{ name: `${name}-dlq`, url: dlq, dlq: true }] : []),
    ];
  });
}

async function readQueues(sqs: SQSClient, env: NodeJS.ProcessEnv): Promise<Snapshot['queues']> {
  return Promise.all(
    queueUrls(env).map(async (q) => {
      const { Attributes: a = {} } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: q.url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
      );
      return { name: q.name, dlq: q.dlq, visible: Number(a.ApproximateNumberOfMessages ?? 0), inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) };
    }),
  );
}

/** Reads the snapshot of the given actors from `table` (and the queues named in `env`). */
/**
 * Reads the snapshot of the given actors from `table` (and the queues named in `env`). With `since`,
 * only trips created at or after it are checked (one run, not every earlier one); every page is read.
 */
export async function collect(opts: {
  table: string;
  env: NodeJS.ProcessEnv;
  passengers: string[];
  drivers: string[];
  waitMs?: number;
  baselineDlq?: Record<string, number>;
  since?: string;
  pageSize?: number;
}): Promise<{ snapshot: Snapshot; read: CheckResult['read'] }> {
  const doc = createDocumentClient(createDynamoClient());
  const tripsRepo = new TripRepo(doc, opts.table);
  const driversRepo = new DriverRepo(doc, opts.table);
  const billing = new BillingRepo(doc, opts.table, new ConsumedRepo(doc, opts.table));
  const sqs = new SQSClient({});

  // Wait for the consumers to drain their queues (billing comes last), up to waitMs.
  const deadline = Date.now() + (opts.waitMs ?? DRAIN_WAIT_MS);
  let queues = await readQueues(sqs, opts.env);
  while (queues.some((q) => !q.dlq && q.visible + q.inFlight > 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    queues = await readQueues(sqs, opts.env);
  }

  const trips = new Map<string, Trip>();
  for (const p of opts.passengers) {
    const ids: string[] = [];
    let start: QueryCommandOutput['LastEvaluatedKey'];
    do {
      const page = await doc.send(
        new QueryCommand({
          TableName: opts.table,
          IndexName: GSI1.indexName,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
          ExpressionAttributeNames: { '#pk': GSI1.partitionKey, '#sk': GSI1.sortKey },
          ExpressionAttributeValues: { ':pk': passengerGsi1Pk(p), ':from': `TRIP#${opts.since ?? ''}`, ':to': 'TRIP#\uffff' },
          ProjectionExpression: 'id',
          ExclusiveStartKey: start,
          ...(opts.pageSize === undefined ? {} : { Limit: opts.pageSize }),
        }),
      );
      ids.push(...(page.Items ?? []).map((i) => String(i.id)));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    // Consistent reads of the trips themselves (the index is eventually consistent).
    for (const t of await tripsRepo.getMany(ids)) trips.set(t.id, t);
  }
  const reservations: Snapshot['reservations'] = [];
  for (const [kind, ids] of [['PASSENGER', opts.passengers], ['DRIVER', opts.drivers]] as const) {
    for (const id of ids) {
      const tripId = await tripsRepo.activeTripId(kind, id);
      reservations.push({ kind, id, tripId });
      if (tripId !== null && !trips.has(tripId)) {
        const t = await tripsRepo.get(tripId);
        if (t !== null) trips.set(t.id, t);
      }
    }
  }
  const drivers: Snapshot['drivers'] = [];
  for (const id of opts.drivers) drivers.push({ id, availability: (await driversRepo.get(id))?.availability ?? null });
  const billed = new Set<string>();
  const eventVersions = new Map<string, number[]>();
  for (const t of trips.values()) {
    if (t.state === 'COMPLETED' || t.state === 'RATED') if ((await billing.get(t.id)) !== null) billed.add(t.id);
    const res = await doc.send(
      new QueryCommand({
        TableName: opts.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ev)',
        ExpressionAttributeValues: { ':pk': tripKey(t.id).PK, ':ev': 'EVENT#' },
        ProjectionExpression: 'SK',
      }),
    );
    eventVersions.set(t.id, (res.Items ?? []).map((i) => Number(String(i.SK).slice('EVENT#'.length))));
  }
  return {
    snapshot: { trips: [...trips.values()], reservations, drivers, billed, eventVersions, queues, baselineDlq: opts.baselineDlq ?? {} },
    read: { trips: trips.size, drivers: drivers.filter((d) => d.availability !== null).length, queues: queues.length },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const table = process.env.RIDECORE_TABLE;
  if (!table) {
    console.error("RIDECORE_TABLE is not set: run 'make up' first");
    process.exit(1);
  }
  if (process.argv[2] === 'baseline') {
    const queues = await readQueues(new SQSClient({}), process.env);
    const baseline: Baseline = { startedAt: new Date().toISOString(), dlq: Object.fromEntries(queues.filter((q) => q.dlq).map((q) => [q.name, q.visible + q.inFlight])) };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline));
    console.log(`load check: DLQ baseline recorded (${queues.filter((q) => q.dlq).length} DLQs)`);
    process.exit(0);
  }
  if (!existsSync(ACTORS_FILE)) {
    console.error(`${ACTORS_FILE} is missing: nothing to check (run 'make load')`);
    process.exit(1);
  }
  const actors = JSON.parse(readFileSync(ACTORS_FILE, 'utf8')) as ActorsFile;
  const baseline: Partial<Baseline> = existsSync(BASELINE_FILE) ? (JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline) : {};
  const { snapshot, read } = await collect({
    table,
    env: process.env,
    passengers: actors.passengers.map((p) => p.id),
    drivers: actors.drivers.map((d) => d.id),
    baselineDlq: baseline.dlq ?? {},
    ...(baseline.startedAt === undefined ? {} : { since: baseline.startedAt }),
  });
  const result = { read, violations: evaluate(snapshot) };
  console.log(`load check: read ${read.trips} trips, ${read.drivers} drivers, ${read.queues} queues; ${result.violations.length} violation(s)`);
  for (const line of result.violations) console.log(`  - ${line}`);
  if (read.trips === 0) console.log('  - no trips read: the run did nothing to check');
  if (read.drivers === 0) console.log('  - no drivers read');
  if (read.queues < QUEUE_COUNT) console.log(`  - only ${read.queues} of ${QUEUE_COUNT} queues read: check the RIDECORE_*_QUEUE_URL / _DLQ_URL settings`);
  process.exit(exitCode(result));
}
