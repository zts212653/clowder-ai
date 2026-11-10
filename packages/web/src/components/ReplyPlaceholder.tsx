import type { ReactNode } from 'react';

/** Shared reply-position frame. Callers supply observed state and identity, never a manufactured response. */
export function ReplyPlaceholder({
  messageId,
  avatar,
  heading,
  children,
  state,
  targetId,
}: {
  messageId: string;
  avatar?: ReactNode;
  heading: ReactNode;
  children: ReactNode;
  state:
    | 'delivering'
    | 'awaiting_reply'
    | 'processing'
    | 'unconfirmed'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'interrupted';
  targetId?: string;
}) {
  return (
    <div
      data-message-id={messageId}
      data-testid="response-lifecycle-tip"
      data-reply-placeholder={state}
      data-reply-target={targetId}
      className="mb-4 flex items-start gap-2"
      role="status"
    >
      {avatar ? (
        <span
          data-reply-avatar
          className={
            ['delivering', 'awaiting_reply', 'processing'].includes(state)
              ? 'animate-pulse motion-reduce:animate-none'
              : undefined
          }
        >
          {avatar}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 pt-1">
        {heading}
        {children}
      </div>
    </div>
  );
}
