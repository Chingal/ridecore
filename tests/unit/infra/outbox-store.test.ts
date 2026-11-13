import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createOutboxStore } from '../../../src/infra/dynamo/outbox-store.ts';

function fakeDoc(pages: { Items: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }[]) {
  const inputs: QueryCommand['input'][] = [];
  const doc = {
    send: (cmd: QueryCommand) => {
      inputs.push(cmd.input);
      return Promise.resolve(pages[inputs.length - 1] ?? { Items: [] });
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, inputs };
}

const items = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ tripId: `t${from + i}` }));

describe('OutboxStore.pending', () => {
  it('pending follows LastEvaluatedKey', async () => {
    const { doc, inputs } = fakeDoc([{ Items: items(3), LastEvaluatedKey: { PK: 'k' } }, { Items: items(2, 3) }]);
    const found = await createOutboxStore(doc, 'tbl').pending(0, '2026-11-13T12:00:00.000Z', 100);
    expect(found).toHaveLength(5);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.ExclusiveStartKey).toEqual({ PK: 'k' });
    expect(inputs[0]).toMatchObject({
      IndexName: 'GSI2',
      ScanIndexForward: true,
      ExpressionAttributeValues: { ':pk': 'OUTBOX#0', ':before': '2026-11-13T12:00:00.000Z' },
    });
  });

  it('stops at the limit without asking for another page', async () => {
    const { doc, inputs } = fakeDoc([{ Items: items(3), LastEvaluatedKey: { PK: 'k' } }, { Items: items(3, 3) }]);
    const found = await createOutboxStore(doc, 'tbl').pending(0, 'z', 3);
    expect(found).toHaveLength(3);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.Limit).toBe(3);
  });
});
