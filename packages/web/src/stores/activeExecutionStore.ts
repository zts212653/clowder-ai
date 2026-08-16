import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import { create } from 'zustand';

export function activeExecutionKey(execution: Pick<ActiveExecutionProjection, 'kind' | 'executionId'>): string {
  return `${execution.kind}:${execution.executionId}`;
}

interface ActiveExecutionState {
  anchorThreadId: string | null;
  projectPath: string | null;
  executionsByKey: Record<string, ActiveExecutionProjection>;
  hydration: 'idle' | 'loading' | 'ready' | 'error';
  hydrationError: string | null;
  requestVersion: number;
  beginHydration(anchorThreadId: string): number;
  applySnapshot(anchorThreadId: string, requestVersion: number, response: ActiveExecutionListResponse): void;
  failHydration(anchorThreadId: string, requestVersion: number, error: unknown): void;
  reset(): void;
}

const INITIAL_STATE = {
  anchorThreadId: null,
  projectPath: null,
  executionsByKey: {},
  hydration: 'idle' as const,
  hydrationError: null,
  requestVersion: 0,
};

export const useActiveExecutionStore = create<ActiveExecutionState>((set, get) => ({
  ...INITIAL_STATE,
  beginHydration(anchorThreadId) {
    const current = get();
    const requestVersion = current.requestVersion + 1;
    const anchorChanged = current.anchorThreadId !== anchorThreadId;
    set({
      anchorThreadId,
      requestVersion,
      hydration: anchorChanged || current.hydration === 'idle' ? 'loading' : current.hydration,
      ...(anchorChanged ? { projectPath: null, executionsByKey: {}, hydrationError: null } : {}),
    });
    return requestVersion;
  },
  applySnapshot(anchorThreadId, requestVersion, response) {
    const current = get();
    if (current.anchorThreadId !== anchorThreadId || current.requestVersion !== requestVersion) return;
    set({
      projectPath: response.projectPath,
      executionsByKey: Object.fromEntries(
        response.executions.map((execution) => [activeExecutionKey(execution), execution]),
      ),
      hydration: 'ready',
      hydrationError: null,
    });
  },
  failHydration(anchorThreadId, requestVersion, error) {
    const current = get();
    if (current.anchorThreadId !== anchorThreadId || current.requestVersion !== requestVersion) return;
    set({
      hydration: 'error',
      hydrationError: error instanceof Error ? error.message : String(error),
    });
  },
  reset() {
    set(INITIAL_STATE);
  },
}));
