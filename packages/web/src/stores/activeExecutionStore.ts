import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import { create } from 'zustand';

export function activeExecutionKey(execution: Pick<ActiveExecutionProjection, 'kind' | 'executionId'>): string {
  return `${execution.kind}:${execution.executionId}`;
}

interface ActiveExecutionState {
  anchorThreadId: string | null;
  projectPath: string | null;
  executionsByKey: Record<string, ActiveExecutionProjection>;
  cancelPendingByKey: Record<string, true>;
  hydration: 'idle' | 'loading' | 'ready' | 'error';
  hydrationError: string | null;
  requestVersion: number;
  beginHydration(anchorThreadId: string): number;
  applySnapshot(anchorThreadId: string, requestVersion: number, response: ActiveExecutionListResponse): void;
  failHydration(anchorThreadId: string, requestVersion: number, error: unknown): void;
  beginCancellation(execution: ActiveExecutionProjection): boolean;
  settleCancellation(execution: ActiveExecutionProjection): void;
  releaseCancellation(execution: ActiveExecutionProjection): void;
  reset(): void;
}

const INITIAL_STATE = {
  anchorThreadId: null,
  projectPath: null,
  executionsByKey: {},
  cancelPendingByKey: {},
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
      ...(anchorChanged
        ? { projectPath: null, executionsByKey: {}, cancelPendingByKey: {}, hydrationError: null }
        : {}),
    });
    return requestVersion;
  },
  applySnapshot(anchorThreadId, requestVersion, response) {
    const current = get();
    if (current.anchorThreadId !== anchorThreadId || current.requestVersion !== requestVersion) return;
    const executionsByKey = Object.fromEntries(
      response.executions.map((execution) => [activeExecutionKey(execution), execution]),
    );
    set({
      projectPath: response.projectPath,
      executionsByKey,
      cancelPendingByKey: Object.fromEntries(
        Object.keys(current.cancelPendingByKey)
          .filter((key) => executionsByKey[key] !== undefined)
          .map((key) => [key, true as const]),
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
  beginCancellation(execution) {
    const key = activeExecutionKey(execution);
    const current = get();
    if (current.cancelPendingByKey[key] || !current.executionsByKey[key]) return false;
    set({ cancelPendingByKey: { ...current.cancelPendingByKey, [key]: true } });
    return true;
  },
  settleCancellation(execution) {
    const key = activeExecutionKey(execution);
    const current = get();
    if (!current.executionsByKey[key]) return;
    set({
      executionsByKey: Object.fromEntries(
        Object.entries(current.executionsByKey).filter(([entryKey]) => entryKey !== key),
      ),
    });
  },
  releaseCancellation(execution) {
    const key = activeExecutionKey(execution);
    const current = get();
    if (!current.cancelPendingByKey[key]) return;
    set({
      cancelPendingByKey: Object.fromEntries(
        Object.entries(current.cancelPendingByKey).filter(([entryKey]) => entryKey !== key),
      ),
    });
  },
  reset() {
    set(INITIAL_STATE);
  },
}));
