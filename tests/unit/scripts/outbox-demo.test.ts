import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { withStreamDisabled } from '../../../scripts/outbox-demo.ts';

function recorder() {
  const order: string[] = [];
  const toggle = (enabled: boolean) => {
    order.push(enabled ? 'enable' : 'disable');
    return Promise.resolve();
  };
  return { order, toggle };
}

describe('withStreamDisabled', () => {
  it('re-enables after success, in the order disable -> enable', async () => {
    const r = recorder();
    const result = await withStreamDisabled(r.toggle, () => Promise.resolve(42), new EventEmitter());
    expect(result).toBe(42);
    expect(r.order).toEqual(['disable', 'enable']);
  });

  it('re-enables after fn throws and rethrows the error', async () => {
    const r = recorder();
    await expect(withStreamDisabled(r.toggle, () => Promise.reject(new Error('boom')), new EventEmitter())).rejects.toThrow('boom');
    expect(r.order).toEqual(['disable', 'enable']);
  });

  it('on SIGINT, cleanup runs before re-enabling', async () => {
    const r = recorder();
    const signals = new EventEmitter();
    const run = withStreamDisabled(
      r.toggle,
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            // fn's own finally: delete the temporary rule and queue.
            setTimeout(() => {
              r.order.push('cleanup');
              reject(new Error('aborted'));
            }, 10);
          });
          setTimeout(() => signals.emit('SIGINT'), 5);
        }),
      signals,
    );
    await expect(run).rejects.toThrow('interrupted');
    expect(r.order).toEqual(['disable', 'cleanup', 'enable']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
});
