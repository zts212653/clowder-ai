'use client';

/**
 * F229 PR-A3a: useConciergeMessages — lightweight message stream for concierge bubble
 *
 * Loads messages for the concierge thread via GET /api/messages.
 * No full chatStore coupling — keeps concierge panel self-contained.
 * Provides optimistic insert + refresh after send.
 *
 * Streaming token-by-token rendering: Phase B2 (requires socket room join).
 * A3a scope: load on open + optimistic insert + refresh-after-send.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RichBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export type ConciergeMessage = {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: number;
  /** Rich blocks from duty cat responses (cards with concierge_teleport/peek/relay/go actions). */
  richBlocks?: RichBlock[];
};

type ApiMessage = {
  id: string;
  type: string;
  catId?: string | null;
  content: string;
  timestamp: number;
  // R8 P1 fix: streaming partial replies arrive with isDraft=true — must not count as real reply
  isDraft?: boolean;
  // R-review R4 P1 fix: carry rich blocks through so bubble can render interaction cards
  extra?: { rich?: { blocks?: RichBlock[] } };
};

function mapApiMessages(raw: ApiMessage[]): ConciergeMessage[] {
  return raw
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && !m.isDraft)
    .map((m) => ({
      id: m.id,
      content: m.content,
      isUser: m.type === 'user',
      timestamp: m.timestamp,
      ...(m.extra?.rich?.blocks?.length ? { richBlocks: m.extra.rich.blocks } : {}),
    }));
}

export function useConciergeMessages(threadId: string | null) {
  const [messages, setMessages] = useState<ConciergeMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const loadMessages = useCallback(async (tid: string) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ threadId: tid, limit: '50' });
      const res = await apiFetch(`/api/messages?${params}`, {
        signal: abortRef.current.signal,
      });
      if (!res.ok) return;
      // Guard: discard if thread changed during fetch
      if (threadIdRef.current !== tid) return;
      const data = await res.json();
      setMessages(mapApiMessages(data.messages ?? []));
    } catch {
      // AbortError expected on unmount or threadId change — ignore
    } finally {
      if (threadIdRef.current === tid) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!threadId) return;
    void loadMessages(threadId);
    return () => abortRef.current?.abort();
  }, [threadId, loadMessages]);

  // Optimistic insert: add user message immediately, return temp id for rollback
  const addOptimistic = useCallback((content: string): string => {
    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setMessages((prev) => [...prev, { id, content, isUser: true, timestamp: Date.now() }]);
    return id;
  }, []);

  // Remove optimistic message (on send failure)
  const removeOptimistic = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  // Re-fetch to confirm message IDs + pick up cat responses
  const refresh = useCallback(() => {
    if (threadIdRef.current) void loadMessages(threadIdRef.current);
  }, [loadMessages]);

  return { messages, isLoading, addOptimistic, removeOptimistic, refresh };
}
