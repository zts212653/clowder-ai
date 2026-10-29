import type {
  SessionChainReadOptions,
  SessionChainReadStage,
} from '../domains/cats/services/stores/ports/SessionChainReadOptions.js';

type Phase =
  | SessionChainReadStage['phase']
  | 'thread_lookup'
  | 'access_check'
  | 'chain_read'
  | 'import_record'
  | 'visibility_filter'
  | 'runtime_metadata'
  | 'response';

interface ReadState {
  phase: Phase;
  since: number;
  phases: Partial<Record<Phase, number>>;
  scope?: 'cat' | 'thread' | 'import';
  index?: SessionChainReadStage['index'];
}

// The existing connection observer owns timers, lifecycle and log budget.
const reads = new WeakMap<object, ReadState>();

export function createSessionListReadDiagnostics(request: object) {
  const state: ReadState = { phase: 'thread_lookup', since: performance.now(), phases: {} };
  reads.set(request, state);
  const phase = (next: Phase): void => {
    const now = performance.now();
    state.phases[state.phase] = (state.phases[state.phase] ?? 0) + now - state.since;
    state.phase = next;
    state.since = now;
  };
  const chainOptions: SessionChainReadOptions = {
    onReadStage: (stage) => {
      if (stage.index) state.index = stage.index;
      phase(stage.phase);
    },
  };
  return {
    phase,
    scope: (scope: ReadState['scope']): void => {
      state.scope = scope;
    },
    chainOptions,
  };
}

export function snapshotSessionListRead(request: object) {
  const state = reads.get(request);
  if (!state) return undefined;
  return {
    phase: state.phase,
    phaseMs: Math.round(performance.now() - state.since),
    phases: Object.fromEntries(Object.entries(state.phases).map(([phase, ms]) => [phase, Math.round(ms)])),
    scope: state.scope,
    ...(state.index
      ? { index: { ...state.index, ...(state.index.build ? { build: { ...state.index.build } } : {}) } }
      : {}),
  };
}
