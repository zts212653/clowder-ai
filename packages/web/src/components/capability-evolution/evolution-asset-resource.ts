'use client';

import {
  type EvolutionAssetReviewV1,
  type ExactAssetVersionRefV1,
  evolutionAssetReviewV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';
import type { EvolutionProgramProjection } from './evolution-program-projection';
import { useEvolutionReading } from './evolution-reading-state';

interface ReadResult {
  review?: EvolutionAssetReviewV1;
  error?: string;
  loading: boolean;
  /** A parsed 422 is stable for this owner/object identity; external signals may still reconcile it. */
  automaticallyRefresh?: boolean;
}
interface State {
  reads: Record<string, ReadResult>;
  catalogs: Record<string, EvolutionAssetReviewV1>;
}
const EMPTY: State = { reads: {}, catalogs: {} };
let state = EMPTY;
let generation = 0;
const listeners = new Set<() => void>();
const requests = new Set<string>();
function emit(next: State) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      state = EMPTY;
      generation += 1;
      requests.clear();
    }
  };
}

function denyOwnerReads() {
  const reads = Object.fromEntries(
    [...new Set([...Object.keys(state.reads), ...requests])].map((id) => [
      id,
      { loading: false, error: '当前无法读取版本来源，请刷新后重试。' },
    ]),
  );
  generation += 1;
  requests.clear();
  emit({ reads, catalogs: {} });
  useEvolutionReading.getState().clearOwnerSelections();
}

function responseCanCarryReview(response: Response): boolean {
  return response.ok || response.status === 422 || response.status === 503;
}

function reviewMatchesRequest(
  review: EvolutionAssetReviewV1,
  projection: EvolutionProgramProjection,
  selectedVersionRef?: ExactAssetVersionRefV1,
): boolean {
  return (
    review.programRef.ownerStateRef === projection.program.programId &&
    review.programRef.ownerFeatureId === 'F311' &&
    refIdentity(review.objectRef) === refIdentity(projection.program.objectRef) &&
    (review.status !== 'resolved' ||
      !selectedVersionRef ||
      (!!review.selected && refIdentity(review.selected.versionRef) === refIdentity(selectedVersionRef)))
  );
}

function newestReview(
  current: EvolutionAssetReviewV1 | undefined,
  incoming: EvolutionAssetReviewV1,
): EvolutionAssetReviewV1 {
  if (current?.status !== 'resolved' || incoming.status !== 'resolved' || incoming.readAt >= current.readAt)
    return incoming;
  return current;
}

function settleReview(key: string, programId: string, review: EvolutionAssetReviewV1, automaticallyRefresh: boolean) {
  const catalog = newestReview(state.catalogs[programId], review);
  emit({
    reads: {
      ...state.reads,
      [key]: { review: newestReview(state.reads[key]?.review, review), loading: false, automaticallyRefresh },
    },
    catalogs: catalog === state.catalogs[programId] ? state.catalogs : { ...state.catalogs, [programId]: catalog },
  });
}

function settleReadError(key: string, programId: string) {
  const { [programId]: removed, ...catalogs } = state.catalogs;
  void removed;
  emit({ reads: { ...state.reads, [key]: { loading: false, error: '版本来源暂时无法读取。' } }, catalogs });
}

async function read(key: string, projection: EvolutionProgramProjection, selectedVersionRef?: ExactAssetVersionRefV1) {
  if (requests.has(key)) return;
  requests.add(key);
  const epoch = generation;
  const id = projection.program.programId;
  const query = selectedVersionRef
    ? `?selectedVersionRef=${encodeURIComponent(JSON.stringify(selectedVersionRef))}`
    : '';
  try {
    const response = await apiFetch(
      `/api/capability-evolution/programs/${encodeURIComponent(id)}/asset-review${query}`,
    );
    if (epoch !== generation) return;
    if (response.status === 401 || response.status === 403) {
      denyOwnerReads();
      return;
    }
    const parsed = evolutionAssetReviewV1Schema.safeParse(await response.json());
    if (epoch !== generation) return;
    if (!parsed.success || !responseCanCarryReview(response)) throw new Error('版本来源暂时无法读取。');
    if (!reviewMatchesRequest(parsed.data, projection, selectedVersionRef))
      throw new Error('版本来源与当前选择不一致。');
    settleReview(key, id, parsed.data, response.status !== 422);
  } catch {
    if (epoch === generation) settleReadError(key, id);
  } finally {
    if (epoch === generation) requests.delete(key);
  }
}

export function useEvolutionAssetReview(
  projection: EvolutionProgramProjection | null,
  selectedVersionRef?: ExactAssetVersionRefV1,
) {
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => EMPTY,
  );
  const programId = projection?.program.programId;
  const objectIdentity = projection ? refIdentity(projection.program.objectRef) : '';
  const selectionIdentity = selectedVersionRef ? refIdentity(selectedVersionRef) : '';
  const key = JSON.stringify([programId, objectIdentity, selectionIdentity]);
  const requestTarget = useRef({ projection, selectedVersionRef });
  requestTarget.current = { projection, selectedVersionRef };
  useEffect(() => {
    if (!surfaceVisible) return;
    const { projection, selectedVersionRef } = requestTarget.current;
    if (!projection) return;
    const reconcile = () => {
      if (document.visibilityState === 'visible') void read(key, projection, selectedVersionRef);
    };
    const poll = () => {
      if (state.reads[key]?.automaticallyRefresh === false) return;
      reconcile();
    };
    void read(key, projection, selectedVersionRef);
    const timer = window.setInterval(poll, 2_000);
    window.addEventListener('focus', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
    };
    // Only exact identities restart this independent owner read, not Program sequence allocations.
  }, [key, surfaceVisible]);
  const result = snapshot.reads[key];
  const catalog = programId ? snapshot.catalogs[programId] : undefined;
  return {
    review: result?.review,
    catalog: catalog?.status === 'resolved' ? catalog : undefined,
    error: result?.error,
    loading: result?.loading ?? !result,
  };
}
