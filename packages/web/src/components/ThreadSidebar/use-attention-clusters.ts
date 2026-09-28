'use client';

import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { type AttentionCluster, buildAttentionClusters } from './attention-clusters';
import type {
  GroupMutationResult,
  GroupSnapshot,
  GroupUndoReceipt,
  ThreadAttentionPreferences,
} from './search-group-types';
import { useGroupOpenInteraction } from './use-group-open-interaction';
import { useGroupPreferenceLoading } from './use-group-preference-loading';

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

async function persistThreadAttentionPreference(input: {
  anchor: string;
  alias?: string | null;
  open?: boolean | null;
  memberSort?: ThreadAttentionMemberSort;
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
  const [memberSort, setMemberSort] = useState<Record<string, ThreadAttentionMemberSort>>({});
  const [pendingSort, setPendingSort] = useState<ReadonlySet<string>>(new Set());
  const [savedGroups, setSavedGroups] = useState<ThreadAttentionPreferences['groups']>([]);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const mutationQueue = useRef<Promise<void>>(Promise.resolve());

  const receivePreferences = useCallback((preferences: ThreadAttentionPreferences) => {
    setAliases(preferences.aliases ?? {});
    setMemberSort(preferences.memberSort ?? {});
    setOpenPreferences(preferences.open ?? {});
    setSavedGroups(preferences.groups ?? []);
    cacheOpenPreferences(preferences.open ?? {});
  }, []);
  const {
    groupLoadState,
    groupLoadError,
    reloadGroups,
    accept: applyPreferences,
  } = useGroupPreferenceLoading(receivePreferences, mutationQueue);

  const clusters = useMemo(() => buildAttentionClusters(rows, savedGroups), [rows, savedGroups]);
  const {
    isOpen,
    begin: beginOpen,
    settle: settleOpen,
  } = useGroupOpenInteraction(openPreferences, currentThreadId, searchQuery);
  const enqueuePreferenceMutation = useCallback(
    (input: {
      anchor: string;
      alias?: string | null;
      open?: boolean | null;
      memberSort?: ThreadAttentionMemberSort;
    }) => {
      const intent = typeof input.open === 'boolean' ? beginOpen(input.anchor, input.open) : null;
      if (input.memberSort) setPendingSort((current) => new Set([...current, input.anchor]));
      const mutation = mutationQueue.current.then(async () => {
        setPreferenceError(null);
        const preferences = await persistThreadAttentionPreference(input);
        applyPreferences(preferences);
        if (intent) settleOpen(intent, true);
      });
      mutationQueue.current = mutation
        .catch(() => {
          if (intent) settleOpen(intent, false);
          setPreferenceError('未能保存这个整理方式，请重试');
        })
        .finally(() => {
          if (input.memberSort)
            setPendingSort((current) => {
              const next = new Set(current);
              next.delete(input.anchor);
              return next;
            });
        });
      return mutationQueue.current;
    },
    [beginOpen, settleOpen, applyPreferences],
  );
  const toggle = useCallback(
    (cluster: AttentionCluster) => {
      const nextOpen = !isOpen(cluster);
      void enqueuePreferenceMutation({ anchor: cluster.anchor, open: nextOpen });
    },
    [enqueuePreferenceMutation, isOpen],
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
    memberSort,
    pendingSort,
    changeMemberSort: (cluster: AttentionCluster, mode: ThreadAttentionMemberSort) =>
      enqueuePreferenceMutation({ anchor: cluster.anchor, memberSort: mode }),
    groupLoadState,
    groupLoadError,
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
