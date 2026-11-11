import { describe, expect, it } from 'vitest';
import { currentCorrelationId, runWithCorrelation } from '../../src/context.ts';

describe('correlation context', () => {
  it('is undefined outside a run', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('is the given id inside a run, also after an await', async () => {
    const seen = await runWithCorrelation('c-1', async () => {
      const before = currentCorrelationId();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [before, currentCorrelationId()];
    });
    expect(seen).toEqual(['c-1', 'c-1']);
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('keeps concurrent runs apart', async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
    const [a, b] = await Promise.all([
      runWithCorrelation('a', async () => (await pause(), currentCorrelationId())),
      runWithCorrelation('b', async () => (await pause(), currentCorrelationId())),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });
});
