import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { IdempotencyRepo } from '../../../src/infra/dynamo/idempotency-repo.ts';

const claimTaken = () => new ConditionalCheckFailedException({ $metadata: {}, message: 'x' });
const heldItem = { requestHash: 'h', leaseUntil: 30, expiresAt: 86_400 };

function runAt(send: ReturnType<typeof vi.fn>, nowMs: number) {
  const repo = new IdempotencyRepo({ send } as unknown as DynamoDBDocumentClient, 'stub', () => nowMs);
  return repo.run<string>({ role: 'passenger', id: 'p1' }, 'k', 'h', async (complete) => {
    complete(200, 'ok');
    return { status: 200, body: 'ok' };
  });
}

describe('IdempotencyRepo lease expiry boundary', () => {
  it('lets the same request take a 30 s lease at 30.5 s', async () => {
    const send = vi.fn().mockRejectedValueOnce(claimTaken()).mockResolvedValueOnce({ Item: heldItem }).mockResolvedValueOnce({});
    await expect(runAt(send, 30_500)).resolves.toEqual({ status: 200, body: 'ok', replayed: false });
    const update = send.mock.calls[2]?.[0] as { input: { ConditionExpression: string } };
    expect(update.input.ConditionExpression).toContain('leaseUntil <= :now');
  });

  it('still blocks the same request before the lease expires', async () => {
    const send = vi.fn().mockRejectedValueOnce(claimTaken()).mockResolvedValueOnce({ Item: heldItem });
    await expect(runAt(send, 29_999)).rejects.toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
