'use client';

import { isLifecycleStoredMessageMetadata, isMessageFrom } from '@cat-cafe/shared';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { CatNameplate } from '../CatNameplate';
import { MessageActions } from '../MessageActions';
import { HubSocketContext } from '../thread-chat/hub-socket-context';
import { useMessageNavigation } from '../thread-chat/MessageNavigationContext';
import type { CausalReadingReference } from './CausalReplyContext';
import { NativeReplyText } from './NativeReplyText';
import { REPLY_BODY_CLASS } from './reply-body';

// The HTTP boundary validates once; this view neither hydrates History nor changes its cursor.
const historyReferenceSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['user', 'assistant', 'connector', 'system', 'summary']),
      content: z.string(),
      catId: z.string().nullable().optional(),
      from: z.custom<NonNullable<ChatMessage['from']>>(isMessageFrom).optional(),
      timestamp: z.number(),
      lifecycle: z.custom<NonNullable<ChatMessage['lifecycle']>>(isLifecycleStoredMessageMetadata).optional(),
      extra: z.object({ recall: z.unknown().optional() }).optional(),
      isDraft: z.boolean().optional(),
    }),
  ),
});

export function CausalReplyReference({
  reference,
  threadId,
  getCatById,
  forwardingDisabled,
  socketConnected,
  targetStatus,
  onClose,
  onReveal,
}: {
  reference: CausalReadingReference;
  threadId: string;
  getCatById: (id: string) => CatData | undefined;
  forwardingDisabled: boolean;
  socketConnected?: boolean | null;
  targetStatus?: string;
  onClose: () => void;
  onReveal?: (element: HTMLElement) => void;
}) {
  const navigate = useMessageNavigation();
  const hub = useContext(HubSocketContext);
  const sectionRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (sectionRef.current) onReveal?.(sectionRef.current);
  }, [onReveal]);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    status: 'loading' | 'unavailable' | 'recalled' | 'ready';
    message?: ChatMessage;
  }>({ status: 'loading' });
  const { anchorMessageId, targetMessageId } = reference;
  // Refresh the same exact canonical message on reconnect/turn-state changes, never scan pages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connection, execution and explicit refresh invalidate this HTTP snapshot.
  useEffect(() => {
    const controller = new AbortController();
    const invalidate = (event: { threadId: string; messageId: string }, status: 'unavailable' | 'recalled') => {
      if (event.threadId !== threadId || event.messageId !== targetMessageId) return;
      controller.abort();
      setResult({ status });
    };
    const releases = [
      hub?.on('message_deleted', (event: { threadId: string; messageId: string }) => invalidate(event, 'unavailable')),
      hub?.on('message_hard_deleted', (event: { threadId: string; messageId: string }) =>
        invalidate(event, 'unavailable'),
      ),
      hub?.on('message_recalled', (event: { threadId: string; messageId: string }) => invalidate(event, 'recalled')),
      hub?.on('message_restored', (event: { threadId: string; messageId: string }) => {
        if (event.threadId === threadId && event.messageId === targetMessageId) setRefresh((value) => value + 1);
      }),
    ];
    setResult((previous) => ({ ...previous, status: 'loading' }));
    const query = new URLSearchParams({ threadId, anchorMessageId: targetMessageId, limit: '1' });
    void apiFetch(`/api/messages?${query}`, { signal: controller.signal })
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : undefined;
        if (controller.signal.aborted) return;
        if (response.status === 410) {
          setResult({ status: 'recalled' });
          return;
        }
        const parsed = historyReferenceSchema.safeParse(body);
        const message = parsed.success ? parsed.data.messages.find((item) => item.id === targetMessageId) : undefined;
        if (!message) setResult({ status: 'unavailable' });
        else if (message.extra?.recall) setResult({ status: 'recalled' });
        else {
          const { extra: _extra, isDraft, ...source } = message;
          const isStreaming =
            isDraft || (source.lifecycle?.kind === 'response' && source.lifecycle.status === 'processing');
          setResult({
            status: 'ready',
            message: { ...source, catId: source.catId ?? undefined, isStreaming: Boolean(isStreaming) },
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ status: 'unavailable' });
      });
    return () => {
      controller.abort();
      releases.forEach((release) => release?.());
    };
  }, [hub, targetMessageId, threadId, socketConnected, targetStatus, refresh]);
  const message = result.message;
  const cat = message?.catId ? getCatById(message.catId) : undefined;
  const status = message?.lifecycle?.kind === 'response' ? message.lifecycle.status : undefined;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="mb-4 border-l-2 border-cafe pl-4"
      data-causal-read-reference={targetMessageId}
    >
      <div className="mb-2 text-xs text-cafe-muted" data-quote-exclude>
        <p className="inline">{reference.kind === 'reply' ? '整轮回复 · 完整文字原文' : '关联消息 · 完整文字原文'}</p>
        <span>
          {status
            ? ` · 执行${status === 'processing' ? '处理中' : status === 'completed' ? '已结束' : status === 'failed' ? '失败' : status === 'canceled' ? '已取消' : '已中断'}`
            : ''}
        </span>
      </div>
      {message && result.status === 'loading' ? (
        <p role="status" className="text-xs text-cafe-muted">
          正在刷新原文…
        </p>
      ) : null}
      {message ? (
        <MessageActions message={message} threadId={threadId} forwardingDisabled={forwardingDisabled} selectionOnly>
          {message.catId ? (
            <CatNameplate catId={message.catId} name={cat ? formatCatName(cat) : message.catId} />
          ) : null}
          {message.content ? (
            <NativeReplyText
              className={REPLY_BODY_CLASS}
              run={{
                kind: 'text',
                id: `reference:${message.id}`,
                start: 0,
                end: message.content.length,
                text: message.content,
              }}
            />
          ) : (
            <p className="text-sm text-cafe-muted">本轮尚无可读取的文字正文。</p>
          )}
        </MessageActions>
      ) : (
        <p role="status" className="text-sm text-cafe-muted">
          {result.status === 'loading'
            ? '正在读取消息…'
            : result.status === 'recalled'
              ? '消息已撤回'
              : '消息暂不可用，可能已删除或无权读取'}
        </p>
      )}
      <div className="mt-2 flex gap-3 text-sm text-cafe-secondary" data-quote-exclude>
        <button type="button" disabled={result.status === 'loading'} onClick={() => setRefresh((value) => value + 1)}>
          刷新原文
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            navigate(anchorMessageId);
          }}
        >
          返回{reference.kind === 'reply' ? '补充消息' : '原消息'}
        </button>
      </div>
    </section>
  );
}
