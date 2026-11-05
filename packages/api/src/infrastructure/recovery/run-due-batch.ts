import { performance } from 'node:perf_hooks';
import { withinRecoveryDeadline } from './recovery-deadline.js';

export interface DueBatchResult<T> {
  selected: number;
  processed: number;
  deferred: number;
  failed: number;
  elapsedMs: number;
  results: T[];
  firstError?: unknown;
}

/** Scheduling only. The selected owner's process method retains every lifecycle/retry/disposition decision. */
export async function runDueBatch<T, R>(input: {
  limit: number;
  budgetMs: number;
  selectDue: (limit: number) => readonly T[] | Promise<readonly T[]>;
  process: (item: T) => R | Promise<R>;
  onItemError: (item: T, error: unknown) => void | Promise<void>;
  clock?: () => number;
}): Promise<DueBatchResult<R>> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isFinite(input.budgetMs) || input.budgetMs < 0)
    throw new Error('invalid_due_batch_budget');
  const clock = input.clock ?? (() => performance.now());
  const started = clock();
  const deadline = started + input.budgetMs;
  const cleanupReserve = Math.min(50, input.budgetMs / 10);
  const selected = await withinRecoveryDeadline(deadline, clock, () => input.selectDue(input.limit));
  if (selected.length > input.limit) throw new Error('due_selector_exceeded_limit');
  const result: DueBatchResult<R> = {
    selected: selected.length,
    processed: 0,
    deferred: 0,
    failed: 0,
    elapsedMs: 0,
    results: [],
  };
  for (const item of selected) {
    if (clock() >= deadline - cleanupReserve) break;
    let admitted = false;
    try {
      result.results.push(
        await withinRecoveryDeadline(deadline - cleanupReserve, clock, () => {
          admitted = true;
          result.processed++;
          return input.process(item);
        }),
      );
    } catch (error) {
      if (!admitted) break;
      result.failed++;
      result.firstError ??= error;
      try {
        await withinRecoveryDeadline(deadline, clock, () => input.onItemError(item, error));
      } catch (ownerError) {
        result.firstError = ownerError;
      }
    }
  }
  result.deferred = selected.length - result.processed;
  result.elapsedMs = Math.max(0, clock() - started);
  return result;
}
