export type PreparationSourcePhase = 'read' | 'project' | 'revalidate';
export type PreparationOwnerFamily = 'project_knowledge' | 'message_evidence' | 'matter' | 'taste';
type Outcome = 'completed' | 'failed';
export type PreparationPhaseObserver = (phase: PreparationSourcePhase) => ((outcome: Outcome) => void) | undefined;

interface PhaseObservation {
  calls: number;
  settled: number;
  failed: number;
  elapsedMs: number;
  pending: Set<{ at: number }>;
}
const families: readonly PreparationOwnerFamily[] = ['project_knowledge', 'message_evidence', 'matter', 'taste'];
const phases: readonly PreparationSourcePhase[] = ['read', 'project', 'revalidate'];
const empty = (): PhaseObservation => ({ calls: 0, settled: 0, failed: 0, elapsedMs: 0, pending: new Set() });

/** One preparation call only. Outer cancellation does not settle an observed child Promise. */
export class PreparationSourceObservations {
  private readonly sources = new Map<PreparationOwnerFamily, Record<PreparationSourcePhase, PhaseObservation>>();

  begin(family: PreparationOwnerFamily, phase: PreparationSourcePhase) {
    if (!families.includes(family) || !phases.includes(phase)) return undefined;
    let source = this.sources.get(family);
    if (!source) {
      source = { read: empty(), project: empty(), revalidate: empty() };
      this.sources.set(family, source);
    }
    const state = source[phase];
    const started = { at: performance.now() };
    state.calls++;
    state.pending.add(started);
    return (outcome: Outcome) => {
      if (!state.pending.delete(started)) return;
      state.settled++;
      if (outcome === 'failed') state.failed++;
      state.elapsedMs += performance.now() - started.at;
    };
  }

  snapshot() {
    const now = performance.now();
    return [...this.sources].map(([family, source]) => ({
      family,
      phases: Object.fromEntries(
        phases.map((phase) => {
          const value = source[phase];
          return [
            phase,
            {
              state: value.pending.size
                ? 'pending'
                : value.failed
                  ? 'failed'
                  : value.settled
                    ? 'completed'
                    : 'not_started',
              calls: value.calls,
              settled: value.settled,
              failed: value.failed,
              pending: value.pending.size,
              elapsedMs: Math.round(
                value.elapsedMs + [...value.pending].reduce((total, start) => total + now - start.at, 0),
              ),
            },
          ];
        }),
      ),
    }));
  }
}

/** Observations are optional and must never replace work, its value, or its original rejection. */
export async function observePreparationPhase<T>(
  observe: PreparationPhaseObserver | undefined,
  phase: PreparationSourcePhase,
  work: () => Promise<T>,
): Promise<T> {
  let end: ReturnType<PreparationPhaseObserver>;
  try {
    end = observe?.(phase);
  } catch {
    /* Diagnostic failure does not change source behavior. */
  }
  let outcome: Outcome = 'failed';
  try {
    const result = await work();
    outcome = 'completed';
    return result;
  } finally {
    try {
      end?.(outcome);
    } catch {
      /* Preserve the original settlement. */
    }
  }
}
