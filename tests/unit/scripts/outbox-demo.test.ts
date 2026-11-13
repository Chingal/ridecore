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

  it('a second SIGINT during cleanup still re-enables the stream', async () => {
    const order: string[] = [];
    let listenersDuringCleanup = 0;
    const signals = new EventEmitter();
    const toggle = (enabled: boolean) => {
      order.push(enabled ? 'enable' : 'disable');
      return Promise.resolve();
    };
    const run = withStreamDisabled(
      toggle,
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => {
            // With no listener left, a real second Ctrl-C would kill node before the stream is re-enabled.
            listenersDuringCleanup = signals.listenerCount('SIGINT');
            signals.emit('SIGINT'); // impatient second press while cleaning up
            setTimeout(() => {
              order.push('cleanup');
              reject(new Error('aborted'));
            }, 10);
          });
          setTimeout(() => signals.emit('SIGINT'), 5);
        }),
      signals,
    );
    await expect(run).rejects.toThrow('interrupted');
    expect(order).toEqual(['disable', 'cleanup', 'enable']);
    expect(listenersDuringCleanup).toBeGreaterThan(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('a disable that fails is undone', async () => {
    const order: string[] = [];
    const toggle = (enabled: boolean) => {
      order.push(enabled ? 'enable' : 'disable');
      return enabled ? Promise.resolve() : Promise.reject(new Error('did not become Disabled'));
    };
    let ran = false;
    await expect(
      withStreamDisabled(toggle, () => {
        ran = true;
        return Promise.resolve(1);
      }, new EventEmitter()),
    ).rejects.toThrow('did not become Disabled');
    expect(ran).toBe(false);
    expect(order).toEqual(['disable', 'enable']);
  });

  it('retries the enable when the mapping is still changing', async () => {
    let enables = 0;
    const toggle = (enabled: boolean) => {
      if (!enabled) return Promise.resolve();
      enables += 1;
      return enables < 3 ? Promise.reject(new Error('ResourceInUseException')) : Promise.resolve();
    };
    await expect(withStreamDisabled(toggle, () => Promise.resolve(1), new EventEmitter(), 0)).resolves.toBe(1);
    expect(enables).toBe(3);
  });
});
