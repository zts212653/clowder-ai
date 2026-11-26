import type { MessagePassageSearchExecution, MessagePassageSearchOptions } from './message-passage-search-types.js';
import { MESSAGE_VECTOR_BUDGET_MS } from './message-search-time-budgets.js';

type Read = (
  mode: 'lexical' | 'semantic' | 'hybrid',
  signal: AbortSignal | undefined,
  vectorStarted?: () => void,
  vectorFinished?: () => void,
) => Promise<MessagePassageSearchExecution>;

/** Optional vectors must leave time for a fresh lexical read and canonical admission. */
export async function readWithMessageVectorBudget(options: MessagePassageSearchOptions, read: Read) {
  const mode = options.mode ?? 'hybrid';
  if (mode !== 'hybrid') return read(mode, options.signal);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const expired = new DOMException('Message vector budget exhausted', 'TimeoutError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vectorStarted = () => {
    timer ??= setTimeout(() => controller.abort(expired), MESSAGE_VECTOR_BUDGET_MS);
  };
  const vectorFinished = () => {
    if (timer) clearTimeout(timer);
  };
  try {
    return await read(mode, signal, vectorStarted, vectorFinished);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error !== expired || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) throw error;
    // Discard the interrupted geometry. The original deadline and grants still
    // apply; a new worker rereads current lexical/index state after cancellation.
    const lexical = await read('lexical', options.signal);
    return {
      ...lexical,
      meta: {
        ...lexical.meta,
        degraded: true,
        degradeReason: 'passage_vector_budget_exhausted' as const,
        effectiveMode: 'lexical' as const,
        semanticCandidatesLimited: true,
      },
    };
  } finally {
    vectorFinished();
  }
}
