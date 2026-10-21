type SearchPhase = 'visibility' | 'source-admission' | 'retrieval' | 'canonical-projection';

/** Error-only operational evidence. Query, principal and canonical bodies are never captured. */
export function observeMessageSearchExecution() {
  const started = performance.now();
  const completedPhases: Partial<Record<SearchPhase, number>> = {};
  return async <T>(phase: SearchPhase, run: () => T | Promise<T>, check?: () => void): Promise<T> => {
    const entered = performance.now();
    try {
      const result = await run();
      check?.();
      completedPhases[phase] = performance.now() - entered;
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
