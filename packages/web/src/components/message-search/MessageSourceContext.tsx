import type { MessageSearchResult } from '@cat-cafe/shared';
import { useLayoutEffect, useRef } from 'react';
import { HighlightedMessageText } from './HighlightedMessageSnippet';
import { excerptHitOffset, queryMatchRanges } from './message-query-presentation';
import { type ReadSourceContext, sourceSpeakerLabel, sourceTime } from './message-source-read';

function paragraphs(text: string) {
  let start = 0;
  return text
    .split(/(\n\s*\n)/u)
    .filter(Boolean)
    .map((content) => {
      const part = { content, start };
      start += content.length;
      return part;
    });
}

export function MessageSourceContext({
  context,
  query,
  result,
  resolveSpeaker,
}: {
  context: ReadSourceContext;
  query: string;
  result: MessageSearchResult;
  resolveSpeaker: (speaker: string) => string;
}) {
  const original = useRef<HTMLDivElement>(null);
  const focusOffset = excerptHitOffset(context.message.content, result);
  useLayoutEffect(() => {
    if (focusOffset === undefined) return;
    const hit = original.current?.querySelector('[data-message-search-focus]');
    const scroll = original.current?.closest<HTMLElement>('[data-message-search-scroll]');
    if (!hit || !scroll) return;
    const viewport = scroll.getBoundingClientRect();
    const paragraph = hit.closest('[data-source-paragraph]')?.getBoundingClientRect();
    const target = paragraph && paragraph.height < viewport.height - 48 ? paragraph : hit.getBoundingClientRect();
    // Only the existing find popover scrolls. The chat/history owner's reading point is untouched.
    if (target.top < viewport.top + 8 || target.bottom > viewport.bottom - 24)
      scroll.scrollTo({ top: scroll.scrollTop + target.top - viewport.top - 24, behavior: 'instant' });
  }, [focusOffset]);
  return (
    <>
      {context.updated && <p className="text-xs">来源已更新，以下是当前原文。</p>}
      {[context.message, ...context.following].map((message, index) => (
        <div key={message.messageId} ref={index === 0 ? original : undefined}>
          <p className="mb-1 text-xs text-cafe-muted">
            {index === 0 ? '原文' : index === 1 ? '后面接着：' : '接着说'} ·{' '}
            {sourceSpeakerLabel(message, resolveSpeaker)} · {sourceTime(message.timestamp)}
          </p>
          <p className="whitespace-pre-wrap break-words leading-6">
            {paragraphs(message.content).map((part) => (
              <span key={part.start} data-source-paragraph>
                <HighlightedMessageText
                  text={part.content}
                  ranges={focusOffset === undefined ? [] : queryMatchRanges(part.content, query)}
                  focusOffset={index === 0 && focusOffset !== undefined ? focusOffset - part.start : undefined}
                />
              </span>
            ))}
          </p>
          {message.truncated && <p className="text-xs">原文较长，这里只展开开头；全文请去原处查看。</p>}
        </div>
      ))}
    </>
  );
}
