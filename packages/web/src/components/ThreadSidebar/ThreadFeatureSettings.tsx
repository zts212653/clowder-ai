'use client';

import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { useShellCopy } from '../shell/shell-copy';
import { threadFeatureCopy } from './thread-feature.shell-copy';

interface ThreadMetadataSnapshot {
  backlogItemId: string | null;
}

interface BacklogItemSummary {
  id: string;
  title: string;
  status: string;
}

function parseThreadMetadata(value: unknown, threadId: string): ThreadMetadataSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid thread detail');
  const candidate = value as Record<string, unknown>;
  if (candidate.id !== threadId) throw new Error('Wrong thread detail');
  if (candidate.backlogItemId != null && typeof candidate.backlogItemId !== 'string') {
    throw new Error('Invalid Feature association');
  }
  return {
    backlogItemId: typeof candidate.backlogItemId === 'string' ? candidate.backlogItemId : null,
  };
}

function parseBacklogItems(value: unknown): BacklogItemSummary[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid Feature list');
  const raw = (value as { items?: unknown }).items;
  if (!Array.isArray(raw)) throw new Error('Invalid Feature list');
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    return typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.status === 'string'
      ? [{ id: candidate.id, title: candidate.title, status: candidate.status }]
      : [];
  });
}

export function ThreadFeatureSettingsContent({ threadId }: { threadId: string }) {
  const copy = useShellCopy(threadFeatureCopy);
  const updateThreadBacklogItem = useChatStore((state) => state.updateThreadBacklogItem);
  const [snapshot, setSnapshot] = useState<ThreadMetadataSnapshot | null>(null);
  const [items, setItems] = useState<BacklogItemSummary[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'load_failed' | 'save_failed'>('idle');

  const load = useCallback(async () => {
    setState('loading');
    setSnapshot(null);
    setItems([]);
    try {
      const [threadResponse, backlogResponse] = await Promise.all([
        apiFetch(`/api/threads/${encodeURIComponent(threadId)}`),
        apiFetch('/api/backlog/items'),
      ]);
      if (!threadResponse.ok || !backlogResponse.ok) throw new Error('metadata unavailable');
      const nextSnapshot = parseThreadMetadata(await threadResponse.json(), threadId);
      const allItems = parseBacklogItems(await backlogResponse.json());
      setSnapshot(nextSnapshot);
      setItems(
        allItems.filter(
          (item) => item.id === nextSnapshot.backlogItemId || (item.status !== 'done' && item.status !== 'cancelled'),
        ),
      );
      setState('idle');
    } catch {
      setState('load_failed');
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { backlogItemId: string | null }) => {
    if (!snapshot || state === 'saving') return;
    const prior = snapshot;
    setState('saving');
    try {
      const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('save rejected');
      const next = parseThreadMetadata(await response.json(), threadId);
      setSnapshot(next);
      updateThreadBacklogItem(threadId, next.backlogItemId);
      void invalidateSidebarProjection();
      setState('idle');
    } catch {
      setSnapshot(prior);
      setState('save_failed');
    }
  };

  const busy = state === 'loading' || state === 'saving';
  return (
    <div className="p-3" data-testid="thread-feature-content">
      {snapshot && (
        <label className="block text-xs text-[var(--shell-muted)]">
          <span className="mb-1.5 block">{copy.feature}</span>
          <select
            value={snapshot.backlogItemId ?? ''}
            disabled={busy}
            onChange={(event) => void save({ backlogItemId: event.target.value || null })}
            className="shell-focusable w-full rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-work)] px-2.5 py-2 text-sm text-[var(--shell-body)]"
            data-testid="thread-feature-select"
          >
            <option value="">{copy.noFeature}</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {state === 'loading' && <p className="py-3 text-sm text-[var(--shell-muted)]">{copy.loading}</p>}
      {state === 'load_failed' && (
        <div className="flex items-center gap-2 py-2 text-sm text-conn-red-text" role="alert">
          <span>{copy.loadFailed}</span>
          <button type="button" className="shell-focusable rounded px-1.5 py-1 font-medium" onClick={() => void load()}>
            {copy.retry}
          </button>
        </div>
      )}
      {state === 'save_failed' && (
        <p className="mt-2 text-xs text-conn-red-text" role="alert">
          {copy.saveFailed}
        </p>
      )}
    </div>
  );
}
