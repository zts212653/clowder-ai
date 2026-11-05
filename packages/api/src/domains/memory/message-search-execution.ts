import type { MessageSearchDiagnostics } from './message-search-diagnostics.js';

type SearchPhase =
  | 'visibility'
  | 'source-admission'
  | 'retrieval'
  | 'canonical-projection'
  | 'qualification'
  | 'final-revalidation';

/** Error-only operational evidence. Query, principal and canonical bodies are never captured. */
export function observeMessageSearchExecution(
  onTrace?: (trace: Record<string, unknown>) => void,
  diagnostics?: MessageSearchDiagnostics,
) {
  const started = performance.now();
  const completedPhases: Partial<Record<SearchPhase, number>> = {};
  return async <T>(phase: SearchPhase, run: () => T | Promise<T>, check?: () => void): Promise<T> => {
    const entered = performance.now();
    try {
      const result = await run();
      check?.();
      completedPhases[phase] = performance.now() - entered;
      try {
        onTrace?.({
          phase,
          elapsedMs: performance.now() - started,
          phaseElapsedMs: completedPhases[phase],
          ...(phase === 'retrieval' || phase === 'canonical-projection' ? diagnostics?.snapshot() : {}),
        });
      } catch {
        /* Optional diagnostics must not replace successful results. */
      }
      return result;
    } catch (error) {
      if (error instanceof Error) {
        try {
          Object.assign(error, {
            messageSearchExecution: {
              phase,
              elapsedMs: performance.now() - started,
              phaseElapsedMs: performance.now() - entered,
              completedPhases: { ...completedPhases },
              ...diagnostics?.snapshot(),
            },
          });
        } catch {
          /* A frozen error remains authoritative, even when it cannot carry diagnostics. */
        }
      }
      throw error;
    }
  };
}
