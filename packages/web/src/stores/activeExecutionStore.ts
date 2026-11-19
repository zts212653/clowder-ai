import type {
  ActiveExecutionListResponse,
  ActiveExecutionProjection,
  ActiveHoldWaitProjection,
} from '@cat-cafe/shared';
import { create } from 'zustand';

export function activeExecutionKey(
  execution: Pick<ActiveExecutionProjection, 'kind' | 'threadId' | 'catId' | 'executionId'>,
): string {
  // Parallel cats share a parent executionId; live identity follows the exact cancel slot.
  // Managed commands retain their globally unique task identity (also read by ConnectorBubble).
  return execution.kind === 'managed_command'
    ? `${execution.kind}:${execution.executionId}`
    : JSON.stringify([execution.kind, execution.threadId, execution.catId, execution.executionId]);
}

interface ActiveExecutionState {
  anchorThreadId: string | null;
  projectPath: string | null;
  scope: 'project' | 'all';
  unavailableProjectPaths: readonly string[];
  executionsByKey: Record<string, ActiveExecutionProjection>;
  /** Held balls: waiting, never running; kept apart so nothing treats them as stoppable work. */
  waits: readonly ActiveHoldWaitProjection[];
  cancelPendingByKey: Record<string, true>;
  hydration: 'idle' | 'loading' | 'ready' | 'error';
  hydrationError: string | null;
  requestVersion: number;
  beginHydration(anchorThreadId: string, projectPath: string | null): number;
  applySnapshot(anchorThreadId: string, requestVersion: number, response: ActiveExecutionListResponse): void;
  failHydration(anchorThreadId: string, requestVersion: number, error: unknown): void;
  beginCancellation(execution: ActiveExecutionProjection): boolean;
  settleCancellation(execution: ActiveExecutionProjection): void;
  releaseCancellation(execution: ActiveExecutionProjection): void;
  /** A confirmed hold cancel removes its row before the next read. */
  settleWaitCancellation(waitId: string): void;
  reset(): void;
}

const INITIAL_STATE = {
  anchorThreadId: null,
  projectPath: null,
  scope: 'project' as const,
  unavailableProjectPaths: [] as readonly string[],
  executionsByKey: {},
  waits: [] as readonly ActiveHoldWaitProjection[],
  cancelPendingByKey: {},
  hydration: 'idle' as const,
  hydrationError: null,
  requestVersion: 0,
};

export const useActiveExecutionStore = create<ActiveExecutionState>((set, get) => ({
  ...INITIAL_STATE,
  beginHydration(anchorThreadId, projectPath) {
    const current = get();
    const requestVersion = current.requestVersion + 1;
    const projectChanged = current.projectPath !== projectPath && current.scope !== 'all';
    set({
      anchorThreadId,
      projectPath,
      requestVersion,
      hydration: projectChanged || current.hydration === 'idle' ? 'loading' : current.hydration,
      ...(projectChanged || (projectPath === null && current.scope !== 'all')
        ? { executionsByKey: {}, waits: [], cancelPendingByKey: {}, hydrationError: null }
        : {}),
    });
    return requestVersion;
  },
  applySnapshot(anchorThreadId, requestVersion, response) {
    const current = get();
    if (current.anchorThreadId !== anchorThreadId || current.requestVersion !== requestVersion) return;
    const executionsByKey = Object.fromEntries(
      response.executions.map((execution) => {
        const key = activeExecutionKey(execution),
          previous = current.executionsByKey[key];
        // A full HTTP receipt allocates rows again; compare only this execution's facts by id.
        return [key, previous && JSON.stringify(previous) === JSON.stringify(execution) ? previous : execution];
      }),
    );
    const sameExecutions =
      Object.keys(executionsByKey).length === Object.keys(current.executionsByKey).length &&
      Object.keys(executionsByKey).every((key) => executionsByKey[key] === current.executionsByKey[key]);
    const unavailable = response.scope === 'all' ? (response.unavailableProjectPaths ?? []) : [];
    set({
      projectPath: response.scope === 'all' ? current.projectPath : response.projectPath,
      scope: response.scope ?? 'project',
      unavailableProjectPaths:
        unavailable.length === current.unavailableProjectPaths.length &&
        unavailable.every((path, i) => path === current.unavailableProjectPaths[i])
          ? current.unavailableProjectPaths
          : unavailable,
      executionsByKey: sameExecutions ? current.executionsByKey : executionsByKey,
      waits: response.waits ?? [],
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
      // A response started before this confirmed cancellation cannot restore its slot.
      requestVersion: current.requestVersion + 1,
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
  settleWaitCancellation(waitId) {
    const current = get();
    if (!current.waits.some((wait) => wait.waitId === waitId)) return;
    set({
      // A response started before this confirmed cancellation cannot restore its row.
      requestVersion: current.requestVersion + 1,
      waits: current.waits.filter((wait) => wait.waitId !== waitId),
    });
  },
  reset() {
    set({ ...INITIAL_STATE, requestVersion: get().requestVersion + 1 });
  },
}));
