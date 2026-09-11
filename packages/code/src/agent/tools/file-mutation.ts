import { runnerSignal } from './workspace.js';

let pending: Promise<unknown> = Promise.resolve();

/** A single executor-wide lock also orders cross-file batches against write/edit. It cannot lock external editors. */
export function withFileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(() => { runnerSignal.getStore()?.throwIfAborted(); return operation(); });
  pending = result.catch(() => {});
  return result;
}
