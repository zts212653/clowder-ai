'use client';

import { useEffect, useRef, useState } from 'react';
import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { kickTeleportResolve, setPendingTeleport } from '@/utils/teleport';

interface GenerationMessages {
  messageIds: string[];
  hasAppendedInputs: boolean;
  complete: boolean;
}

/** The API shares the running cat's eligibility predicate; the browser never guesses from a paged window. */
export function GenerationMessagesNotice({
  response,
  threadId,
  timelineMessages,
}: {
  response: ChatMessage;
  threadId: string;
  timelineMessages: readonly ChatMessage[];
}) {
  const lifecycle = response.lifecycle?.kind === 'response' ? response.lifecycle : undefined;
  const navigateToMessage = useMessageNavigation();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [loaded, setLoaded] = useState<{ key: string; value: GenerationMessages } | null>(null);
  const [nextIndex, setNextIndex] = useState(0);
  const eligible = Boolean(
    lifecycle &&
      Number.isFinite(lifecycle.startedAt) &&
      (lifecycle.status === 'processing' || Number.isFinite(lifecycle.completedAt)),
  );
  const inputs = lifecycle?.inputMessageIds.join('|');
  const key = `${threadId}:${response.id}:${inputs}`;
  const result = loaded?.key === key ? loaded.value : null;
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      rootMargin: '400px',
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  // A queued source can publish without changing its ID. Streaming token updates do not refetch.
  const frontier =
    lifecycle?.status === 'processing'
      ? timelineMessages
          .map(
            (message) =>
              `${message.id}:${message.queuedEntryId ?? ''}:${Boolean(message.content.trim() || message.contentBlocks?.length || message.extra?.rich?.blocks.length)}`,
          )
          .join('|')
      : '';
  const status = lifecycle?.status;
  useEffect(() => {
    if (!eligible || !threadId || !visible) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void apiFetch(
        `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(response.id)}/generation-messages`,
        { signal: abort.signal },
      )
        .then(async (res) => (res.ok ? res.json() : null))
        .then((body: GenerationMessages | null) => {
          if (!abort.signal.aborted && body?.complete && Array.isArray(body.messageIds))
            setLoaded({ key, value: body });
        })
        .catch(() => {
          /* No evidence means no historical count, not a failed-read claim. */
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [eligible, visible, threadId, response.id, status, key, frontier]);
  const jump = () => {
    if (!result?.messageIds.length) return;
    const messageId = result.messageIds[nextIndex % result.messageIds.length]!;
    if (!navigateToMessage(messageId)) {
      setPendingTeleport({ threadId, messageId });
      kickTeleportResolve();
    }
    setNextIndex((index) => (index + 1) % result.messageIds.length);
  };
  return (
    <div ref={host}>
      {result?.messageIds.length ? (
        <div
          className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-cafe-muted"
          data-testid="generation-messages-notice"
        >
          <span>
            生成期间{result.hasAppendedInputs ? '另' : ''}有 {result.messageIds.length} 条新消息没并进这一轮 ·
            读没读查不到 ·
          </span>
          <button
            type="button"
            className="hover:underline"
            onClick={jump}
            title={`跳到第 ${(nextIndex % result.messageIds.length) + 1} 条；再次点击查看下一条`}
          >
            看这些 ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}
