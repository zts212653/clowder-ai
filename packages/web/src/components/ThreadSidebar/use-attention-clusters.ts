'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { type AttentionCluster, buildAttentionClusters, resolveAttentionClusterOpen } from './attention-clusters';

import type {
  GroupMutationResult,
  GroupSnapshot,
  GroupUndoReceipt,
  ThreadAttentionPreferences,
} from './search-group-types';

const OPEN_PREFERENCE_KEY = 'cat-cafe:f277:cluster-open:v1';

export type LegacyThreadAttentionGroupCommand =
  | { action: 'create'; threadIds: string[]; name?: string }
  | { action: 'move'; groupId: string; threadId: string; beforeThreadId?: string }
  | { action: 'remove'; groupId: string; threadId: string }
  | { action: 'rename'; groupId: string; name: string | null };

export type ThreadAttentionGroupCommand =
  | LegacyThreadAttentionGroupCommand
  | { action: 'organize'; threadIds: string[]; expectedGroups: GroupSnapshot[]; name?: string; groupId?: string }
  | ({ action: 'undo' } & GroupUndoReceipt);

function readOpenPreferences(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OPEN_PREFERENCE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    );
  } catch {
    return {};
  }
}

async function fetchThreadAttentionPreferences(): Promise<ThreadAttentionPreferences | null> {
  try {
    const response = await apiFetch('/api/config/thread-attention');
    if (!response.ok) return null;
    return (await response.json()) as ThreadAttentionPreferences;
  } catch {
    return null;
  }
}

async function persistThreadAttentionPreference(input: {
  anchor: string;
  alias?: string | null;
  open?: boolean | null;
}): Promise<ThreadAttentionPreferences> {
  const response = await apiFetch('/api/config/thread-attention', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ThreadAttentionPreferences;
}

async function persistThreadAttentionGroupCommand(
  command: ThreadAttentionGroupCommand,
): Promise<ThreadAttentionPreferences> {
  const response = await apiFetch('/api/config/thread-attention/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ThreadAttentionPreferences;
}

function cacheOpenPreferences(open: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(OPEN_PREFERENCE_KEY, JSON.stringify(open));
  } catch {
    // Server state remains recovery truth when browser storage is unavailable.
  }
}

export function useAttentionClusters(
  rows: readonly SidebarSnapshotRow[],
  currentThreadId: string,
  searchQuery: string,
) {
  const [openPreferences, setOpenPreferences] = useState<Record<string, boolean>>(readOpenPreferences);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [savedGroups, setSavedGroups] = useState<ThreadAttentionPreferences['groups']>([]);
  const [groupLoadState, setGroupLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  const applyPreferences = useCallback((preferences: ThreadAttentionPreferences) => {
    setAliases(preferences.aliases ?? {});
    setOpenPreferences(preferences.open ?? {});
    setSavedGroups(preferences.groups ?? []);
    cacheOpenPreferences(preferences.open ?? {});
    setGroupLoadState('ready');
  }, []);
  const reloadGroups = useCallback(async () => {
    await mutationQueue.current;
    setGroupLoadState('loading');
    const preferences = await fetchThreadAttentionPreferences();
    if (preferences) applyPreferences(preferences);
    else setGroupLoadState('error');
    return preferences;
  }, [applyPreferences]);

  useEffect(() => {
    let cancelled = false;
    void fetchThreadAttentionPreferences().then((preferences) => {
      if (cancelled) return;
      if (preferences) applyPreferences(preferences);
      else setGroupLoadState('error');
    });
    return () => {
      cancelled = true;
    };
  }, [applyPreferences]);

  const clusters = useMemo(() => buildAttentionClusters(rows, savedGroups), [rows, savedGroups]);
  const isOpen = useCallback(
    (cluster: AttentionCluster) => resolveAttentionClusterOpen(cluster, openPreferences, currentThreadId, searchQuery),
    [currentThreadId, openPreferences, searchQuery],
  );
  const enqueuePreferenceMutation = useCallback(
    (input: { anchor: string; alias?: string | null; open?: boolean | null }) => {
      const mutation = mutationQueue.current.then(async () => {
        setPreferenceError(null);
        const preferences = await persistThreadAttentionPreference(input);
        const nextAliases = preferences.aliases ?? {};
        const nextOpen = preferences.open ?? {};
        setAliases(nextAliases);
        setOpenPreferences(nextOpen);
        setSavedGroups(preferences.groups ?? []);
        cacheOpenPreferences(nextOpen);
      });
      mutationQueue.current = mutation.catch(() => {
        setPreferenceError('未能保存这个整理方式，请重试');
      });
      return mutationQueue.current;
    },
    [],
  );
  const toggle = useCallback(
    (cluster: AttentionCluster) => {
      const nextOpen = !resolveAttentionClusterOpen(cluster, openPreferences, currentThreadId, searchQuery);
      void enqueuePreferenceMutation({ anchor: cluster.anchor, open: nextOpen });
    },
    [currentThreadId, enqueuePreferenceMutation, openPreferences, searchQuery],
  );

  const enqueueGroupMutation = useCallback(
    (command: ThreadAttentionGroupCommand): Promise<GroupMutationResult> => {
      const mutation = mutationQueue.current.then(async (): Promise<GroupMutationResult> => {
        setPreferenceError(null);
        try {
          const preferences = await persistThreadAttentionGroupCommand(command);
          applyPreferences(preferences);
          return { ok: true, preferences };
        } catch (error) {
          const conflict = error instanceof Error && error.message === 'HTTP 409';
          const message = conflict ? '对话组已发生变化，请重新查看后再整理' : '未能保存这个对话组，请重试';
          setPreferenceError(command.action === 'undo' ? null : message);
          return { ok: false, error: message, conflict };
        }
      });
      mutationQueue.current = mutation.then(() => undefined);
      return mutation;
    },
    [applyPreferences],
  );

  const titleFor = useCallback((cluster: AttentionCluster) => aliases[cluster.anchor] ?? cluster.title, [aliases]);
  const rename = useCallback(
    (cluster: AttentionCluster, alias: string | null) => {
      const normalized = alias?.trim() || null;
      void enqueueGroupMutation({ action: 'rename', groupId: cluster.groupId, name: normalized });
    },
    [enqueueGroupMutation],
  );

  return {
    clusters,
    savedGroups,
    groupLoadState,
    reloadGroups,
    openGroup: (groupId: string) => enqueuePreferenceMutation({ anchor: `group:${groupId}`, open: true }),
    isOpen,
    toggle,
    titleFor,
    rename,
    mutateGroup: enqueueGroupMutation,
    preferenceError,
  };
}
