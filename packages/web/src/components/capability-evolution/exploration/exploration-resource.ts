'use client';

import {
  type EvolutionExplorationReviewV1,
  type EvolutionExplorationSelectionV1,
  type EvolutionResolvedExplorationReviewV1,
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';

interface Read {
  scope: string;
  loading: boolean;
  review?: EvolutionResolvedExplorationReviewV1;
  error?: string;
  errorKind?: 'transport' | 'source' | 'integrity';
  blockers?: EvolutionExplorationReviewV1['blockers'];
  recoverySelection?: EvolutionExplorationSelectionV1;
}
interface State {
  reads: Record<string, Read>;
  catalogs: Record<string, EvolutionResolvedExplorationReviewV1>;
}
const EMPTY: State = { reads: {}, catalogs: {} };
let state = EMPTY;
let generation = 0;
const listeners = new Set<() => void>();
const requests = new Map<string, AbortController>();
const scopeTickets = new Map<string, number>();
const activeKeys = new Map<string, string>();
let nextTicket = 0;
function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      generation++;
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      scopeTickets.clear();
      activeKeys.clear();
      state = EMPTY;
    }
  };
}
function failScope(
  scope: string,
  key: string,
  error: string,
  errorKind: Read['errorKind'] = 'source',
  blockers?: EvolutionExplorationReviewV1['blockers'],
  recoverySelection?: EvolutionExplorationSelectionV1,
) {
  const { [scope]: removed, ...catalogs } = state.catalogs;
  void removed;
  const reads = Object.fromEntries(Object.entries(state.reads).filter(([, read]) => read.scope !== scope));
  emit({
    catalogs,
    reads: { ...reads, [key]: { scope, loading: false, error, errorKind, blockers, recoverySelection } },
  });
}
function transportFailure(scope: string, key: string, previous?: EvolutionResolvedExplorationReviewV1) {
  emit({
    ...state,
    reads: {
      ...state.reads,
      [key]: {
        scope,
        loading: false,
        errorKind: 'transport',
        ...(previous ? { review: previous } : {}),
        error: previous
          ? `暂未刷新，仍展示上次读取成功的记录（${previous.readAt}）；当前回放与输入保留。请重试。`
          : '记录读取中断，当前选择与输入已保留。请重试。',
      },
    },
  });
}

async function read(
  scope: string,
  key: string,
  projection: EvolutionProgramProjection,
  selection: EvolutionExplorationSelectionV1,
  automatic = false,
  preserveScope = false,
) {
  if (requests.has(key) || (automatic && state.reads[key]?.errorKind === 'integrity')) return;
  const ticket = ++nextTicket;
  scopeTickets.set(scope, ticket);
  for (const [previousKey, previous] of requests) {
    if (previousKey !== key && state.reads[previousKey]?.scope === scope) {
      previous.abort();
      requests.delete(previousKey);
    }
  }
  const controller = new AbortController();
  requests.set(key, controller);
  const epoch = generation;
  const isCurrent = () => epoch === generation && scopeTickets.get(scope) === ticket;
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  const previousKey = activeKeys.get(scope);
  const previous = previousKey === key ? state.reads[key]?.review : undefined;
  activeKeys.set(scope, key);
  const fail = (
    error: string,
    kind: Read['errorKind'],
    blockers?: Read['blockers'],
    recovery?: EvolutionExplorationSelectionV1,
  ) => {
    if (!preserveScope) return failScope(scope, key, error, kind, blockers, recovery);
    emit({
      ...state,
      reads: {
        ...state.reads,
        [key]: { scope, loading: false, error, errorKind: kind, blockers, recoverySelection: recovery },
      },
    });
  };
  emit({
    ...state,
    reads: { ...state.reads, [key]: { scope, loading: true, ...(previous ? { review: previous } : {}) } },
  });
  const params = new URLSearchParams();
  for (const [name, ref] of Object.entries(selection)) if (ref) params.set(name, JSON.stringify(ref));
  try {
    const response = await apiFetch(
      `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}/exploration?${params}`,
      { signal: controller.signal },
    );
    if (!isCurrent()) return;
    if (response.status === 401 || response.status === 403) {
      generation++;
      for (const pending of requests.values()) pending.abort();
      requests.clear();
      activeKeys.clear();
      scopeTickets.clear();
      emit({
        catalogs: {},
        reads: { [key]: { scope, loading: false, error: '当前身份无法读取这些记录，请重新登录后重试。' } },
      });
      useEvolutionReading.getState().clearOwnerSelections();
      return;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = evolutionExplorationReviewV1Schema.safeParse(body);
    if (!isCurrent()) return;
    if (!parsed.success) {
      if (response.status >= 500) transportFailure(scope, key, previous);
      else
        fail(
          response.status === 404
            ? '项目或来源已不再可读；请回到可用版本。'
            : '来源返回的记录未通过契约核验，已移除对应证据。请核对来源后重试。',
          'integrity',
        );
      return;
    }
    const review = parsed.data;
    if (
      review.programRef.ownerFeatureId !== 'F311' ||
      review.programRef.ownerStateRef !== projection.program.programId ||
      refIdentity(review.objectRef) !== refIdentity(projection.program.objectRef)
    ) {
      fail('来源身份与本项目不一致，已移除对应证据。请核对来源后重试。', 'integrity');
      return;
    }
    if (review.status !== 'resolved') {
      if (review.status === 'unavailable' && previous?.publication) {
        transportFailure(scope, key, previous);
        return;
      }
      fail(
        review.recoverySelection
          ? '上次阅读位置属于较早的内容版本。原选择已保留，可以打开最新历史重新定位。'
          : review.status === 'invalid'
            ? '来源未通过完整性或契约核验，已停止使用这些探索记录。请核对来源后重新读取。'
            : '来源暂时无法提供这些探索记录；可重试或回读准备材料。',
        review.status === 'invalid' ? 'integrity' : 'source',
        review.blockers,
        review.recoverySelection,
      );
      return;
    }
    if (!response.ok || !evolutionExplorationSelectionMatches(review, selection)) {
      fail('来源与所选记录不一致，已移除对应证据。请核对来源后重试。', 'integrity');
      return;
    }
    const invalid = review.details.some(
      (detail) =>
        detail.status === 'invalid' ||
        (detail.status === 'resolved' && detail.records.some((record) => record.mediaStatus?.status === 'invalid')),
    );
    emit({
      reads: {
        ...state.reads,
        [key]: { scope, loading: false, review, ...(invalid ? { errorKind: 'integrity' as const } : {}) },
      },
      catalogs: { ...state.catalogs, [scope]: { ...review, details: [] } },
    });
  } catch {
    if (isCurrent()) transportFailure(scope, key, previous);
  } finally {
    window.clearTimeout(timer);
    if (requests.get(key) === controller) requests.delete(key);
    // A failed prefetch must leave the visible selection as the active read.
    if (preserveScope && isCurrent() && !state.reads[key]?.review && previousKey && activeKeys.get(scope) === key)
      activeKeys.set(scope, previousKey);
  }
}

function selectionKey(scope: string, selection: EvolutionExplorationSelectionV1) {
  return JSON.stringify([
    scope,
    selection.selectedSourceRef ? refIdentity(selection.selectedSourceRef) : null,
    selection.selectedNodeRef ? refIdentity(selection.selectedNodeRef) : null,
    selection.selectedExperimentRef ? refIdentity(selection.selectedExperimentRef) : null,
    selection.comparisonExperimentRef ? refIdentity(selection.comparisonExperimentRef) : null,
  ]);
}

/** Shared canonical reads across sidecar/main; detail is never borrowed from a previous selection. */
export function useEvolutionExploration(
  projection: EvolutionProgramProjection,
  selection: EvolutionExplorationSelectionV1,
) {
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
  const scope = JSON.stringify([
    projection.program.workspaceId,
    projection.program.programId,
    refIdentity(projection.program.objectRef),
  ]);
  const key = selectionKey(scope, selection);
  const target = useRef({ projection, selection });
  target.current = { projection, selection };
  const retry = useCallback(() => {
    void read(scope, key, target.current.projection, target.current.selection);
  }, [scope, key]);
  const prepareSelection = useCallback(
    async (next: EvolutionExplorationSelectionV1) => {
      const nextKey = selectionKey(scope, next);
      await read(scope, nextKey, target.current.projection, next, false, true);
      const prepared = state.reads[nextKey]?.review;
      return Boolean(prepared && evolutionExplorationSelectionMatches(prepared, next));
    },
    [scope],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new owner sequence must refresh the same selection identity
  useEffect(() => {
    if (!surfaceVisible) return;
    void read(scope, key, target.current.projection, target.current.selection, true);
    const refresh = () => {
      if (document.visibilityState === 'visible')
        void read(scope, key, target.current.projection, target.current.selection, true);
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [retry, scope, key, projection.program.sequence, surfaceVisible]);
  const result = snapshot.reads[key];
  const catalog = result?.review ?? snapshot.catalogs[scope];
  return {
    review: result?.review,
    catalog:
      catalog &&
      (!selection.selectedSourceRef || refIdentity(catalog.sourceRef) === refIdentity(selection.selectedSourceRef))
        ? catalog
        : undefined,
    loading: result?.loading ?? true,
    error: result?.error,
    blockers: result?.blockers,
    recoverySelection: result?.recoverySelection,
    retry,
    prepareSelection,
  };
}
