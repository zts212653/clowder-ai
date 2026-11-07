'use client';

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useChatStore } from '../stores/chatStore';
import { apiSessionIdentity } from '../utils/api-session-identity';
import { threadArtifactsEntry } from './thread-artifacts-store';
import { selectThreadMessagesRaw, useThreadLiveness } from './useThreadScopedSelectors';

export type WorksSourceChange = { reason: 'material' | 'activity' | 'access' };

/** Validate the socket-event boundary once; coordinates are optional even for explicit revocation. */
export function worksSourceInvalidation(event: Event) {
  const raw: unknown = (event as CustomEvent<unknown>).detail;
  const detail = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const ownerUserId = typeof detail.ownerUserId === 'string' ? detail.ownerUserId : undefined;
  const currentOwner = apiSessionIdentity.getSnapshot().ownerUserId;
  if (ownerUserId && currentOwner && ownerUserId !== currentOwner) return null;
  const reason: WorksSourceChange['reason'] =
    detail.reason === 'access_revoked' ? 'access' : detail.reason === 'works_changed' ? 'material' : 'activity';
  return { reason, threadId: typeof detail.threadId === 'string' ? detail.threadId : undefined };
}

/** Thread readers may revalidate on completion; global catalogues distinguish material from ordinary activity. */
export function useWorksSourceRefresh(
  threadId: string | undefined,
  enabled: boolean,
  refetch: (change: WorksSourceChange) => void,
  scopeToThread = true,
) {
  const messages = useChatStore((state) => selectThreadMessagesRaw(state, enabled ? (threadId ?? null) : null));
  const { hasActive } = useThreadLiveness(enabled ? (threadId ?? null) : null);
  const materialKey = useMemo(
    () =>
      JSON.stringify(
        messages
          .flatMap((message) => {
            const blocks = message.extra?.rich?.blocks?.filter(
              (block) =>
                ['media_gallery', 'file', 'diff', 'audio', 'html_widget'].includes(block.kind) ||
                (block.kind === 'card' && block.meta?.kind === 'work_reference'),
            );
            const content = message.contentBlocks?.filter((block) => block.type === 'image' || block.type === 'file');
            return blocks?.length || content?.length ? [[message.id, blocks, content]] : [];
          })
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ),
    [messages],
  );
  const previous = useRef({ threadId, materialKey, enabled, hasActive });
  useEffect(() => {
    const before = previous.current;
    previous.current = { threadId, materialKey, enabled, hasActive };
    if (
      enabled &&
      before.enabled &&
      before.threadId === threadId &&
      (before.materialKey !== materialKey || (before.hasActive && !hasActive))
    )
      refetch({ reason: before.materialKey !== materialKey ? 'material' : 'activity' });
  }, [enabled, materialKey, threadId, refetch, hasActive]);
  useEffect(() => {
    if (!enabled) return;
    const changed = (event: Event) => {
      const change = worksSourceInvalidation(event);
      if (!change || (scopeToThread && threadId && change.threadId && change.threadId !== threadId)) return;
      refetch(change);
    };
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', changed);
    return () => {
      window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', changed);
    };
  }, [enabled, threadId, refetch, scopeToThread]);
}

export function useThreadArtifacts(threadId: string | undefined, view?: 'works', active = true) {
  const scopeThreadId = view === 'works' && threadId === 'default' ? undefined : threadId;
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const key = JSON.stringify([identity.ownerUserId, identity.generation, scopeThreadId, view]);
  const entry = useMemo(() => threadArtifactsEntry(key, scopeThreadId, view), [key, scopeThreadId, view]);
  const subscribe = useCallback((listener: () => void) => entry.subscribe(listener, active), [entry, active]);
  const snapshot = useSyncExternalStore(subscribe, entry.getSnapshot, entry.getSnapshot);
  const refetch = useCallback(() => {
    if (active) entry.refetch();
  }, [active, entry]);
  useWorksSourceRefresh(scopeThreadId, active && view === 'works', refetch);
  return { ...snapshot, loading: active && snapshot.loading, refetch };
}
