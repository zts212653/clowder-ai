'use client';

import { useSendMessage } from '@/hooks/useSendMessage';
import type { ChatMessage } from '@/stores/chat-types';
import { checkSendAttempt, useSendAttemptStore } from '@/stores/send-attempt-store';
import { apiSessionIdentity } from '@/utils/api-session-identity';

export function SendAttemptStatus({
  attempt,
  threadId,
}: {
  attempt: NonNullable<ChatMessage['sendAttempt']>;
  threadId: string;
}) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId ?? '';
  const stored = useSendAttemptStore((state) =>
    state.attempts.find((item) => item.id === attempt.id && item.threadId === threadId && item.ownerUserId === owner),
  );
  const { handleSend } = useSendMessage(threadId);
  const failed = attempt.status === 'failed';
  const unknown = attempt.status === 'unknown';
  const checking = attempt.status === 'checking';
  const busy = attempt.status === 'preparing' || attempt.status === 'sending' || checking;
  const text = failed
    ? `未发出${attempt.error ? ` · ${attempt.error}` : ''}`
    : unknown
      ? '暂未确认是否发出'
      : checking
        ? '正在确认是否发出…'
        : attempt.status === 'accepted'
          ? '已发出 · 等待接收确认'
          : attempt.status === 'delivered'
            ? '已投递 · 正在同步回执'
            : '发送中…';
  const retry = () => {
    if (stored)
      void handleSend(
        stored.content,
        stored.files,
        stored.threadId,
        stored.whisper,
        stored.replyTo,
        stored.contextAttachments,
        stored.explicitTargetCats,
        { localAttempt: true, idempotencyKey: stored.id },
      );
  };
  return (
    <span
      data-testid="send-attempt-status"
      data-send-status={attempt.status}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      className={`inline-flex flex-wrap items-center justify-end gap-1.5 text-xs ${failed ? 'text-conn-red-text' : unknown ? 'text-semantic-warning' : 'text-cafe-muted'}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
      >
        {busy ? (
          <path d="M8 2a6 6 0 1 1-6 6" />
        ) : (
          <>
            <circle cx="8" cy="8" r="6" />
            <path d={failed ? 'M8 4v5m0 2v1' : unknown ? 'M6 6a2 2 0 1 1 3 1.7L8 9m0 2v1' : 'm4.5 8 2.2 2.2 4.8-4.5'} />
          </>
        )}
      </svg>
      <span>{text}</span>
      {stored && (failed || unknown || checking) ? (
        <button
          type="button"
          disabled={checking}
          onClick={failed ? retry : () => void checkSendAttempt(stored)}
          className="shell-focusable min-h-11 min-w-11 rounded px-1 underline underline-offset-4 disabled:cursor-wait"
          aria-label={failed ? '重试发送这条消息' : '检查这条消息是否发出'}
        >
          {failed ? '重试' : checking ? '检查中…' : '检查状态'}
        </button>
      ) : null}
      {attempt.persistenceError ? (
        <span>恢复信息未更新</span>
      ) : unknown && attempt.error ? (
        <span>{attempt.error}</span>
      ) : null}
    </span>
  );
}
