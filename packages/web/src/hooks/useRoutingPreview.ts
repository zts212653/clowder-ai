'use client';

import {
  type RoutingPreviewReason,
  type RoutingPreviewResponse,
  routingPreviewResponseSchema,
} from '@cat-cafe/shared/routing-preview';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export type RoutingPreviewScope =
  | { scope: 'thread'; threadId: string }
  | { scope: 'new-thread'; preferredCats: readonly string[] };

export type ComposerRoutingPreviewReason = RoutingPreviewReason | { kind: 'whisper_recipients' };

export type RoutingPreviewState =
  | { status: 'idle'; targetCats: []; reason: null }
  | { status: 'loading'; targetCats: []; reason: null }
  | { status: 'error'; targetCats: []; reason: null }
  | {
      status: 'ready';
      targetCats: RoutingPreviewResponse['targetCats'];
      reason: ComposerRoutingPreviewReason;
      unavailableTargets?: RoutingPreviewResponse['unavailableTargets'];
    };

export function useRoutingPreview({
  enabled,
  content,
  scope,
  refreshKey = '',
  suspended = false,
}: {
  enabled: boolean;
  content: string;
  scope: RoutingPreviewScope | null;
  refreshKey?: string | number;
  suspended?: boolean;
}): RoutingPreviewState {
  const [state, setState] = useState<RoutingPreviewState>({ status: 'idle', targetCats: [], reason: null });
  const scopeKind = scope?.scope;
  const threadId = scope?.scope === 'thread' ? scope.threadId : '';
  const preferredCatsKey = scope?.scope === 'new-thread' ? scope.preferredCats.join('\u0000') : '';
  const scopeKey = scopeKind === 'thread' ? `thread:${threadId}` : scopeKind === 'new-thread' ? 'new-thread' : '';
  const previousScopeKey = useRef('');

  // `refreshKey` is an event identity rather than request payload: a reply or a
  // preferred-cat save must re-run the same draft projection without inventing
  // a wire field solely to satisfy dependency inference.
  // Keep `content` as a dependency even when its @ tokens are unchanged. The
  // canonical router also consumes #ideate and routing-policy intent words; a
  // mention-only client key would make this preview disagree with real send.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey deliberately retriggers an identical request.
  useEffect(() => {
    if (!enabled || !scopeKind) {
      previousScopeKey.current = '';
      setState({ status: 'idle', targetCats: [], reason: null });
      return;
    }
    const scopeChanged = previousScopeKey.current !== scopeKey;
    previousScopeKey.current = scopeKey;
    if (scopeChanged) setState({ status: 'loading', targetCats: [], reason: null });
    if (suspended) return;
    const controller = new AbortController();
    let current = true;
    setState((previous) =>
      scopeChanged || previous.status !== 'ready' ? { status: 'loading', targetCats: [], reason: null } : previous,
    );
    const timer = window.setTimeout(() => {
      const body =
        scopeKind === 'thread'
          ? { scope: 'thread' as const, threadId, content }
          : {
              scope: 'new-thread' as const,
              preferredCats: preferredCatsKey ? preferredCatsKey.split('\u0000') : [],
              content,
            };
      void apiFetch('/api/routing/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Routing preview failed: ${response.status}`);
          const parsed = routingPreviewResponseSchema.safeParse(await response.json());
          if (!parsed.success) throw new Error('Invalid routing preview response');
          if (current) setState({ status: 'ready', ...parsed.data });
        })
        .catch((error: unknown) => {
          if (!current || controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setState({ status: 'error', targetCats: [], reason: null });
        });
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [content, enabled, preferredCatsKey, refreshKey, scopeKey, scopeKind, suspended, threadId]);

  return state;
}
