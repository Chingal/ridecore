import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ correlationId: string }>();

/** Runs `fn` with `correlationId` as the current correlation id (visible across awaits inside it). */
export function runWithCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ correlationId }, fn);
}

/** The correlation id of the current run, or undefined outside any run. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
