'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';
import { type EvolutionProgramProjection, parseProgramProjection } from './evolution-program-projection';
import { useEvolutionReading } from './evolution-reading-state';

interface Snapshot {
  listRecords: Readonly<Record<string, EvolutionProgramProjection>>;
  records: Readonly<Record<string, EvolutionProgramProjection>>;
  ids: readonly string[];
  ready: Readonly<Record<string, boolean>>;
  errors: Readonly<Record<string, string | undefined>>;
  rejected: number;
}
const EMPTY: Snapshot = { listRecords: {}, records: {}, ids: [], ready: {}, errors: {}, rejected: 0 };
const LIST = 'list';
let snapshot = EMPTY;
let generation = 0;
const listeners = new Set<() => void>();
const requests = new Map<string, Promise<void>>();

function emit(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      // Reconstructable network cache only. Owner data is never persisted in browser storage.
      generation += 1;
      requests.clear();
      snapshot = EMPTY;
    }
  };
}
function isOlder(current: EvolutionProgramProjection | undefined, incoming: EvolutionProgramProjection) {
  return (
    current &&
    current.program.workspaceId === incoming.program.workspaceId &&
    current.program.sequence > incoming.program.sequence
  );
}
function newest(records: Snapshot['records'], incoming: EvolutionProgramProjection) {
  const id = incoming.program.programId;
  if (isOlder(records[id], incoming)) return records;
  return { ...records, [id]: incoming };
}

/** Publish only validated owner responses, including CAS conflicts, to every mounted consumer. */
export function acceptProgramProjection(value: unknown): boolean {
  const projection = parseProgramProjection(value);
  if (!projection) return false;
  const id = projection.program.programId;
  if (isOlder(snapshot.listRecords[id], projection)) return false;
  emit({
    ...snapshot,
    listRecords: newest(snapshot.listRecords, projection),
    records: newest(snapshot.records, projection),
    ready: { ...snapshot.ready, [id]: true },
    errors: { ...snapshot.errors, [id]: undefined },
  });
  return true;
}

async function fetchProjection(key: string): Promise<void> {
  const epoch = generation;
  try {
    const response = await apiFetch(
      key === LIST
        ? '/api/capability-evolution/programs'
        : `/api/capability-evolution/programs/${encodeURIComponent(key)}`,
    );
    if (epoch !== generation) return;
    if (response.status === 401 || response.status === 403) {
      generation += 1;
      requests.clear();
      emit({ ...EMPTY, ready: { [key]: true }, errors: { [key]: '当前无法读取这项记录，请刷新后重试。' } });
      useEvolutionReading.getState().clearOwnerSelections();
      return;
    }
    if (!response.ok) {
      if (response.status === 404 && key !== LIST) {
        const { [key]: removed, ...records } = snapshot.records;
        const { [key]: removedFromList, ...listRecords } = snapshot.listRecords;
        void removed;
        void removedFromList;
        emit({ ...snapshot, records, listRecords, ids: snapshot.ids.filter((id) => id !== key) });
      }
      throw new Error('暂时无法读取进化记录，请稍后刷新。');
    }
    const body: unknown = await response.json();
    if (epoch !== generation) return;
    if (key === LIST) {
      const values = body && typeof body === 'object' && 'programs' in body ? body.programs : undefined;
      if (!Array.isArray(values)) throw new Error('进化记录格式暂时无法读取。');
      const parsed = values.flatMap((value) => {
        const item = parseProgramProjection(value);
        return item ? [item] : [];
      });
      const workspaceIds = new Set(parsed.map((item) => item.program.workspaceId));
      const inWorkspace = (records: Snapshot['records']) =>
        Object.fromEntries(Object.entries(records).filter(([, item]) => workspaceIds.has(item.program.workspaceId)));
      let listRecords = inWorkspace(snapshot.listRecords);
      for (const item of parsed) listRecords = newest(listRecords, item);
      emit({
        ...snapshot,
        // List responses intentionally omit preparation bodies. They cannot replace an exact read.
        records: inWorkspace(snapshot.records),
        listRecords,
        ids: parsed.map((item) => item.program.programId),
        rejected: values.length - parsed.length,
      });
    } else {
      const projection = parseProgramProjection(body);
      if (!projection || projection.program.programId !== key) throw new Error('这项进化记录暂时无法读取。');
      acceptProgramProjection(projection);
    }
    emit({ ...snapshot, ready: { ...snapshot.ready, [key]: true }, errors: { ...snapshot.errors, [key]: undefined } });
  } catch (cause) {
    if (epoch !== generation) return;
    emit({
      ...snapshot,
      ready: { ...snapshot.ready, [key]: true },
      errors: { ...snapshot.errors, [key]: cause instanceof Error ? cause.message : '暂时无法读取进化记录。' },
    });
  }
}
function refresh(key: string) {
  const pending = requests.get(key);
  if (pending) return pending;
  const request = fetchProjection(key).finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

export function useEvolutionPrograms(programId?: string) {
  const key = programId ?? LIST;
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY,
  );
  const reload = useCallback(() => refresh(key), [key]);
  useEffect(() => {
    if (!surfaceVisible) return;
    void reload();
    const visible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const timer = window.setInterval(visible, 2_000);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [reload, surfaceVisible]);
  return {
    programs: state.ids.flatMap((id) => (state.listRecords[id] ? [state.listRecords[id]] : [])),
    projection: programId ? (state.records[programId] ?? null) : null,
    loading: !state.ready[key],
    error: state.errors[key],
    rejected: state.rejected,
    reload,
  };
}
