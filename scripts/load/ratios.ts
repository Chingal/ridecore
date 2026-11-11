import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createDocumentClient, createDynamoClient } from '../../src/infra/dynamo/client.ts';
import { GSI1, passengerGsi1Pk } from '../../src/infra/dynamo/keys.ts';

/**
 * Evidence for docs/load-testing.md: for load trips created in [from, to), how many got at least one
 * offer and, of those that finished, how many have a billing record. Reads every page.
 *   node --import ./scripts/load-env.ts scripts/load/ratios.ts <from ISO> <to ISO> [passengers=600]
 */
const [from, to, count = '600'] = process.argv.slice(2);
const table = process.env.RIDECORE_TABLE;
if (!from || !to || !table) {
  console.error('Usage: scripts/load/ratios.ts <from ISO> <to ISO> [passengers] (with RIDECORE_TABLE set)');
  process.exit(1);
}
const doc = createDocumentClient(createDynamoClient());
const result = { from, to, trips: 0, offered: 0, finished: 0, billed: 0 };
for (let i = 1; i <= Number(count); i++) {
  let start: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: GSI1.indexName,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#pk': GSI1.partitionKey, '#sk': GSI1.sortKey },
        ExpressionAttributeValues: { ':pk': passengerGsi1Pk(`load-passenger-${i}`), ':from': `TRIP#${from}`, ':to': `TRIP#${to}` },
        ProjectionExpression: 'id',
        ExclusiveStartKey: start,
      }),
    );
    for (const { id } of page.Items ?? []) {
      const items = (
        await doc.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `TRIP#${String(id)}` }, ConsistentRead: true }))
      ).Items ?? [];
      const trip = items.find((x) => x.SK === 'META');
      result.trips++;
      if (items.some((x) => String(x.SK).startsWith('OFFER#'))) result.offered++;
      if (trip?.state === 'COMPLETED' || trip?.state === 'RATED') {
        result.finished++;
        if (items.some((x) => x.SK === 'BILLING')) result.billed++;
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}
console.log(JSON.stringify(result));
