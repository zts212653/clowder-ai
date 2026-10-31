'use client';

import { useEffect, useState } from 'react';
import { resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';
import { apiFetch } from '@/utils/api-client';
import { resolveOriginalPlace } from '../shell/mailbox/original-place';
import { parseUnifiedAttentionRead } from '../shell/parse-unified-attention';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '../shell/use-unified-attention';

export interface GroupDecisionRead {
  status: 'loading' | 'ready' | 'error';
  threadIds: ReadonlySet<string>;
}

/** Read every page of the existing owner-fenced pending view, never guessing decisions from runtime presence. */
export async function readGroupDecisionThreads(
  signal: AbortSignal,
  request: typeof apiFetch = apiFetch,
): Promise<ReadonlySet<string>> {
  const session = await request('/api/session', { signal });
  const identity: unknown = session.ok ? await session.json() : null;
  const owner = typeof identity === 'object' && identity !== null && 'userId' in identity ? identity.userId : null;
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('Session not confirmed');
  const ids = new Set<string>();
  let preferenceRevision: number | undefined;
  for (let offset = 0; ; offset += 20) {
    signal.throwIfAborted();
    const response = await request(
      `/api/concierge/work/decisions?view=unified&offset=${offset}&limit=20&personalView=visible`,
      { signal },
      { afterCurrentGet: true },
    );
    const read = response.ok ? parseUnifiedAttentionRead(await response.json()) : null;
    if (
      !read ||
      read.identity.ownerUserId !== owner ||
      read.personalView?.mode !== 'visible' ||
      !Number.isSafeInteger(read.personalView.preferenceRevision) ||
      read.page.offset !== offset ||
      read.page.limit !== 20 ||
      read.status !== 'available' ||
      read.consistency.state !== 'verified' ||
      Object.values(read.sources).some(
        (source) => source.status !== 'available' || source.exhaustiveness !== 'complete',
      )
    )
      throw new Error('Pending decisions not confirmed');
    const revision = read.personalView.preferenceRevision;
    if (preferenceRevision !== undefined && revision !== preferenceRevision)
      throw new Error('Pending preferences changed between pages');
    preferenceRevision = revision;
    for (const item of read.items) {
      if (item.kind !== 'approval' && item.kind !== 'judgment') continue;
      if (item.kind === 'approval' && item.approval?.resolution !== 'open') continue;
      const place = resolveOriginalPlace(item);
      const target = place.kind === 'exact' ? resolveEntrustedWorkActionTarget(place.actionRef) : null;
      if (target?.kind === 'message') ids.add(target.threadId);
    }
    if (!read.page.hasMore) return ids;
    if (read.items.length !== 20) throw new Error('Pending page made no progress');
  }
}

/** Reuse the pending view's invalidations; this leaf never writes, approves or marks a decision handled. */
export function useGroupDecisions(enabled: boolean): GroupDecisionRead {
  const [state, setState] = useState<GroupDecisionRead>({ status: 'loading', threadIds: new Set() });
  useEffect(() => {
    if (!enabled) return;
    let controller: AbortController | undefined;
    const read = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      setState({ status: 'loading', threadIds: new Set() });
      void readGroupDecisionThreads(current.signal).then(
        (threadIds) => {
          if (!current.signal.aborted) setState({ status: 'ready', threadIds });
        },
        () => {
          if (!current.signal.aborted) setState({ status: 'error', threadIds: new Set() });
        },
      );
    };
    read();
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, read);
    return () => {
      controller?.abort();
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, read);
    };
  }, [enabled]);
  return state;
}
