'use client';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { MarkdownContent } from '../MarkdownContent';
import { MessageActionSlot } from '../MessageActionSlot';
import { SuggestionAvatar, SuggestionRow } from '../suggestions/SuggestionRow';

export function WatcherNudgeMessage({
  message,
  cat,
  threadId,
}: {
  message: ChatMessage;
  cat?: CatData;
  threadId: string;
}) {
  return (
    <>
      <article className="w-line my-3" data-message-id={message.id} data-testid="watcher-nudge">
        <div className="mb-2 flex items-center gap-2 text-xs text-cafe-secondary">
          {message.catId && <SuggestionAvatar catId={message.catId} watcher />}
          <span>
            守望猫 · {message.catId === 'codex61-sol' ? '小太阳' : (cat?.nickname ?? cat?.displayName ?? message.catId)}
          </span>
          <MessageActionSlot />
        </div>
        <MarkdownContent content={message.content} />
      </article>
      <SuggestionRow threadId={threadId} messageId={message.id} />
    </>
  );
}
