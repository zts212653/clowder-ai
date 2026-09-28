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
      return;
    }
    const parsed = evolutionAssetReviewV1Schema.safeParse(await response.json());
    if (epoch !== generation) return;
    if (!parsed.success || (!response.ok && response.status !== 422 && response.status !== 503))
      throw new Error('版本来源暂时无法读取。');
    const review = parsed.data;
    if (
      review.programRef.ownerStateRef !== id ||
      review.programRef.ownerFeatureId !== 'F311' ||
      refIdentity(review.objectRef) !== refIdentity(projection.program.objectRef) ||
      (review.status === 'resolved' &&
        selectedVersionRef &&
        (!review.selected || refIdentity(review.selected.versionRef) !== refIdentity(selectedVersionRef)))
    )
      throw new Error('版本来源与当前选择不一致。');
    const previous = state.reads[key]?.review;
    const useIncoming =
      previous?.status !== 'resolved' || review.status !== 'resolved' || review.readAt >= previous.readAt;
    const catalog = state.catalogs[id];
    const useCatalog =
      catalog?.status !== 'resolved' || review.status !== 'resolved' || review.readAt >= catalog.readAt;
    emit({
      reads: { ...state.reads, [key]: { review: useIncoming ? review : previous, loading: false } },
      catalogs: useCatalog ? { ...state.catalogs, [id]: review } : state.catalogs,
    });
  } catch {
    if (epoch === generation) {
      const { [id]: removed, ...catalogs } = state.catalogs;
      void removed;
      emit({ reads: { ...state.reads, [key]: { loading: false, error: '版本来源暂时无法读取。' } }, catalogs });
    }
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
    const refresh = () => {
      if (document.visibilityState === 'visible') void read(key, projection, selectedVersionRef);
    };
    void read(key, projection, selectedVersionRef);
    const timer = window.setInterval(refresh, 2_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
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
