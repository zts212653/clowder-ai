'use client';

import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';

export function projectAppendedInputReceipts(
  response: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (
    response.lifecycle?.kind !== 'response' ||
    response.lifecycle.inputEntryIds.length < 2 ||
    response.lifecycle.inputMessageIds.length < 2
  ) {
    return [];
  }
  const startedAt = response.lifecycle.startedAt;
  const byId = new Map(timelineMessages.map((message) => [message.id, message]));
  return response.lifecycle.inputMessageIds.slice(1).flatMap((messageId) => {
    const source = byId.get(messageId);
    return source && source.timestamp > startedAt ? [source] : [];
  });
}

function formatReceiptTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function sourceLabel(message: ChatMessage, coCreatorName: string, getCatLabel: (catId: string) => string): string {
  switch (message.from?.kind) {
    case 'user':
      return coCreatorName;
    case 'agent':
      return getCatLabel(message.from.catId);
    case 'external':
      return message.from.sender?.name ?? message.source?.label ?? message.from.connectorId;
    case 'plugin':
      return message.source?.label ?? message.from.instanceId;
    case 'system':
      return message.from.service;
    default:
      return message.catId ? getCatLabel(message.catId) : coCreatorName;
  }
}

interface AppendedInputReceiptsProps {
  response: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  coCreatorName: string;
  getCatLabel: (catId: string) => string;
}

export function AppendedInputReceipts({
  response,
  timelineMessages,
  coCreatorName,
  getCatLabel,
}: AppendedInputReceiptsProps) {
  const appendedInputs = projectAppendedInputReceipts(response, timelineMessages);
  if (appendedInputs.length === 0) return null;

  return (
    <section
      data-testid="appended-input-receipts"
      aria-label="补充消息"
      className="mt-2 border-t border-cafe px-1 pt-2 text-xs text-cafe-secondary"
    >
      <div className="font-semibold text-cafe-muted">补充消息</div>
      <ol className="mt-1 space-y-2">
        {appendedInputs.map((source) => {
          const content = source.content.trim() || '（无文字内容）';
          return (
            <li key={source.id} data-appended-input-id={source.id}>
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-medium">{sourceLabel(source, coCreatorName, getCatLabel)}:</span>
                <span className="min-w-0 truncate" title={content}>
                  {content}
                </span>
                <button
                  type="button"
                  className="shrink-0 font-medium text-[var(--color-cocreator-primary)] hover:underline"
                  onClick={() => focusLineageMessage(source.id)}
                >
                  查看消息
                </button>
              </div>
              <time
                dateTime={new Date(source.timestamp).toISOString()}
                className="mt-0.5 block text-micro text-cafe-muted"
              >
                {formatReceiptTimestamp(source.timestamp)}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
