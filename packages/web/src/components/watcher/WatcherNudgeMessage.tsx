'use client';
import type { LifecycleActiveRun } from '@cat-cafe/shared';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { MarkdownContent } from '../MarkdownContent';
import { MessageActionSlot } from '../MessageActionSlot';
import { MessageDispatchAvatars } from '../MessageDispatchAvatars';
import { SuggestionAvatar, SuggestionRow } from '../suggestions/SuggestionRow';

function nudgeSentence(
  content: string,
  targetId: string | undefined,
  sourcePath: string,
  sourceId: string | undefined,
) {
  let sentence = content;
  const mention = targetId ? `@${targetId}\n\n` : undefined;
  if (mention && sentence.startsWith(mention)) sentence = sentence.slice(mention.length);
  if (sourceId) {
    for (const key of ['message', 'messageId']) {
      const suffix = `\n\n[原话](${sourcePath}?${key}=${encodeURIComponent(sourceId)})`;
      if (sentence.endsWith(suffix)) sentence = sentence.slice(0, -suffix.length);
    }
  }
  return sentence;
}

export function WatcherNudgeMessage({
  message,
  cat,
  threadId,
  getCatById,
  timelineMessages = [],
  activeRuns = [],
}: {
  message: ChatMessage;
  cat?: CatData;
  threadId: string;
  getCatById: (id: string) => CatData | undefined;
  timelineMessages?: readonly ChatMessage[];
  activeRuns?: readonly LifecycleActiveRun[];
}) {
  const targetId = message.extra?.targetCats?.[0];
  const target = targetId ? getCatById(targetId) : undefined;
  const sourceId = message.extra?.watcher?.sourceMessageId;
  const sourcePath = `/thread/${encodeURIComponent(threadId)}`;
  const sourceHref = sourceId ? `${sourcePath}?message=${encodeURIComponent(sourceId)}` : undefined;
  // Routing and the exact appended citation belong to this row's chrome, not its sentence.
  const body = nudgeSentence(message.content, targetId, sourcePath, sourceId);
  return (
    <>
      <article className="w-line my-3" data-message-id={message.id} data-testid="watcher-nudge">
        <div
          data-quote-exclude
          className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-cafe-secondary"
        >
          {message.catId && <SuggestionAvatar catId={message.catId} watcher />}
          <span className="font-medium text-cafe-text">
            守望猫 · {message.catId === 'codex61-sol' ? '小太阳' : (cat?.nickname ?? cat?.displayName ?? message.catId)}
          </span>
          {targetId && <span>→ {target ? formatCatName(target) : targetId}</span>}
          <time dateTime={new Date(message.timestamp).toISOString()}>
            ·{' '}
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          </time>
          <MessageActionSlot />
        </div>
        <MarkdownContent content={body} />
        {sourceHref && (
          <a data-quote-exclude className="mt-1 inline-block text-xs text-cafe-accent" href={sourceHref}>
            原话
          </a>
        )}
        <div data-quote-exclude>
          <MessageDispatchAvatars
            inline
            message={message}
            threadId={threadId}
            timelineMessages={timelineMessages}
            activeRuns={activeRuns}
            getCatLabel={(id) => {
              const member = getCatById(id);
              return member ? formatCatName(member) : id;
            }}
          />
        </div>
      </article>
      <SuggestionRow threadId={threadId} messageId={message.id} />
    </>
  );
}
