'use client';

import type { ChatMessage } from '@/stores/chat-types';

export interface MessageAppendSource {
  messageId: string;
  sourceLabel: string;
  quote: string;
  seenAt: number;
}

function sourceLabel(message: ChatMessage): string {
  return message.type === 'user' && !message.catId ? '你' : (message.catId ?? '系统');
}

function shortQuote(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 96 ? `${compact.slice(0, 96)}…` : compact;
}

/**
 * Uses the original message's persisted queue receipt as the only source of
 * truth. No provider stdout parsing or nearby-message heuristics are involved.
 */
export function collectMessageAppendSources(
  messages: readonly ChatMessage[],
  invocationId: string | undefined,
): MessageAppendSource[] {
  if (!invocationId) return [];
  const sources = messages.flatMap((message) => {
    const targets = message.extra?.queueReceipt?.targets ?? [];
    const matching = targets.find(
      (target) =>
        target.invocationId === invocationId &&
        target.seenAt !== undefined &&
        target.authorIntent?.requested === 'continue_current' &&
        target.authorIntent.effective === 'continue_current',
    );
    if (!matching?.seenAt) return [];
    return [
      {
        messageId: message.id,
        sourceLabel: sourceLabel(message),
        quote: shortQuote(message.content),
        seenAt: matching.seenAt,
      },
    ];
  });
  return sources.sort((left, right) => left.seenAt - right.seenAt || left.messageId.localeCompare(right.messageId));
}

export function MessageAppendIndicator({ sources }: { sources: readonly MessageAppendSource[] }) {
  if (sources.length === 0) return null;
  return (
    <details
      className="mt-2 rounded-md border border-conn-blue-ring/60 bg-conn-blue-bg/60 px-2 py-1 text-xs text-[var(--semantic-info)]"
      data-testid="message-append-indicator"
    >
      <summary className="cursor-pointer font-medium" aria-label="查看已追加到本次回复的消息">
        已追加到本次回复{sources.length > 1 ? `（${sources.length} 条）` : ''}
      </summary>
      <ul className="mt-1 space-y-1 pl-4 text-cafe-secondary">
        {sources.map((source) => (
          <li key={source.messageId} data-append-source-message-id={source.messageId}>
            <span className="font-medium">{source.sourceLabel}：</span>
            <q>{source.quote}</q>
          </li>
        ))}
      </ul>
    </details>
  );
}
