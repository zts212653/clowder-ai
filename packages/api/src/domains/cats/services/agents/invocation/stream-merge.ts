/**
 * Async Stream Merger
 * 合并多个 AsyncIterable，谁先 yield 谁先出。
 * 所有流结束后完成。单个流报错不影响其他流。
 *
 * 算法: Promise.race 池
 * 1. 每个 AsyncIterable 转 AsyncIterator
 * 2. 每个 iterator 调 .next() 放入 race 池
 * 3. race 出第一个结果 → yield → 重新填入该 iterator 的下一个 promise
 * 4. iterator done → 移出池
 * 5. iterator reject → 以 onError 回调通知调用方, 移出池
 * 6. 池空 → generator 结束
 */

/** Tagged promise so we know which stream resolved */
interface TaggedResult<T> {
  index: number;
  result: IteratorResult<T>;
}

interface TaggedError {
  index: number;
  error: unknown;
}

type TaggedOutcome<T> =
  | { kind: 'result'; value: TaggedResult<T> }
  | { kind: 'error'; value: TaggedError }
  | { kind: 'stream-abort'; index: number }
  | { kind: 'batch-abort' };

export interface MergeStreamsOptions<T = never> {
  /** Abort the whole merge, including children whose next() never settles. */
  signal?: AbortSignal;
  /** Abort one child without cancelling healthy sibling streams. */
  signalForIndex?: (index: number) => AbortSignal | undefined;
  /** Optional terminal value emitted immediately when a child is aborted. */
  valueForAbort?: (index: number) => T;
}

function reportCleanupError(
  onError: ((index: number, error: unknown) => void) | undefined,
  index: number,
  error: unknown,
): void {
  try {
    onError?.(index, error);
  } catch {
    // Cleanup must remain best-effort even if an observer throws.
  }
}

/**
 * Ask an unfinished child to close without awaiting it. Native async
 * generators may queue return() behind an already-pending next(), so awaiting
 * here would recreate the deadlock this merger is responsible for breaking.
 */
function closeIterator<T>(
  index: number,
  iterators: AsyncIterator<T>[],
  pending: Map<number, Promise<TaggedOutcome<T>>>,
  terminal: Set<number>,
  onError: ((index: number, error: unknown) => void) | undefined,
): void {
  if (terminal.has(index)) return;
  terminal.add(index);
  pending.delete(index);
  const iterator = iterators[index];
  if (!iterator?.return) return;
  try {
    void Promise.resolve(iterator.return()).catch((error: unknown) => reportCleanupError(onError, index, error));
  } catch (error) {
    reportCleanupError(onError, index, error);
  }
}

function createAbortOutcome<T>(
  signal: AbortSignal | undefined,
  outcome: TaggedOutcome<T>,
  cleanups: Array<() => void>,
): Promise<TaggedOutcome<T>> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve(outcome);
  return new Promise<TaggedOutcome<T>>((resolve) => {
    const onAbort = (): void => resolve(outcome);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  });
}

function armIterator<T>(
  index: number,
  iterators: AsyncIterator<T>[],
  pending: Map<number, Promise<TaggedOutcome<T>>>,
  terminal: Set<number>,
  streamAbort: Promise<TaggedOutcome<T>> | undefined,
): void {
  const iterator = iterators[index];
  if (!iterator || terminal.has(index)) return;
  const next = Promise.resolve()
    .then(() => iterator.next())
    .then(
      (result): TaggedOutcome<T> => ({ kind: 'result', value: { index, result } }),
      (error): TaggedOutcome<T> => ({ kind: 'error', value: { index, error } }),
    );
  pending.set(index, streamAbort ? Promise.race([next, streamAbort]) : next);
}

type MergeAction<T> = { kind: 'stop' } | { kind: 'continue' } | { kind: 'yield'; index: number; value: T };

function applyOutcome<T>(
  outcome: TaggedOutcome<T>,
  iterators: AsyncIterator<T>[],
  pending: Map<number, Promise<TaggedOutcome<T>>>,
  terminal: Set<number>,
  onError: ((index: number, error: unknown) => void) | undefined,
): MergeAction<T> {
  if (outcome.kind === 'batch-abort') return { kind: 'stop' };
  if (outcome.kind === 'stream-abort') {
    closeIterator(outcome.index, iterators, pending, terminal, onError);
    return { kind: 'continue' };
  }
  if (outcome.kind === 'error') {
    const { index, error } = outcome.value;
    terminal.add(index);
    pending.delete(index);
    onError?.(index, error);
    return { kind: 'continue' };
  }

  const { index, result } = outcome.value;
  if (result.done) {
    terminal.add(index);
    pending.delete(index);
    return { kind: 'continue' };
  }
  return { kind: 'yield', index, value: result.value };
}

/**
 * Merge multiple async iterables, yielding values as they arrive.
 * @param streams The async iterables to merge
 * @param onError Optional callback when a stream errors (stream is removed from pool)
 */
export async function* mergeStreams<T>(
  streams: AsyncIterable<T>[],
  onError?: (index: number, error: unknown) => void,
  options: MergeStreamsOptions<T> = {},
): AsyncGenerator<T> {
  if (streams.length === 0) return;

  const iterators = streams.map((s) => s[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<TaggedOutcome<T>>>();
  const terminal = new Set<number>();
  const abortCleanups: Array<() => void> = [];

  const streamAborts = iterators.map((_, index) =>
    createAbortOutcome<T>(options.signalForIndex?.(index), { kind: 'stream-abort', index }, abortCleanups),
  );
  const batchAbort = createAbortOutcome<T>(options.signal, { kind: 'batch-abort' }, abortCleanups);

  // Arm all iterators initially
  for (let i = 0; i < iterators.length; i++) {
    armIterator(i, iterators, pending, terminal, streamAborts[i]);
  }

  try {
    while (pending.size > 0) {
      const candidates = batchAbort ? [...pending.values(), batchAbort] : pending.values();
      const outcome = await Promise.race(candidates);

      if (outcome.kind === 'batch-abort') {
        for (const index of [...pending.keys()]) {
          closeIterator(index, iterators, pending, terminal, onError);
          if (options.valueForAbort) yield options.valueForAbort(index);
        }
        break;
      }
      if (outcome.kind === 'stream-abort') {
        closeIterator(outcome.index, iterators, pending, terminal, onError);
        if (options.valueForAbort) yield options.valueForAbort(outcome.index);
        continue;
      }

      const action = applyOutcome(outcome, iterators, pending, terminal, onError);
      if (action.kind === 'stop') break;
      if (action.kind === 'yield') {
        yield action.value;
        armIterator(action.index, iterators, pending, terminal, streamAborts[action.index]);
      }
    }
  } finally {
    for (const cleanup of abortCleanups) cleanup();
    for (let index = 0; index < iterators.length; index++) {
      closeIterator(index, iterators, pending, terminal, onError);
    }
  }
}
