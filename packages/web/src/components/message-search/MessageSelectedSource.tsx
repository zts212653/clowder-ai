import type { MessageSearchResult } from '@cat-cafe/shared';
import { ChatReferenceScope } from '../chat-references/ChatReferenceScope';
import { MarkdownContent } from '../MarkdownContent';
import { extractFocusedSelectionExcerpt } from './focused-selection-excerpt';
import { sourceSpeakerLabel, sourceTime } from './message-source-read';

/** The Host's structural proof and the cat's interpretation have separate subjects. */
export function MessageSelectedSource({
  result,
  speaker,
  resolveSpeaker,
}: {
  result: MessageSearchResult;
  speaker: string;
  resolveSpeaker: (id: string) => string;
}) {
  const selected = result.selection;
  if (!selected) return null;
  const { context, quotation, part } = selected;
  const origin = quotation?.origin;
  const headingPath = selected.headingPath;
  const excerpt = extractFocusedSelectionExcerpt(context);
  const prefix = excerpt.truncatedBefore ? '…' : '';
  return (
    <div className="min-w-0 text-sm leading-[1.55] text-cafe-secondary" data-message-selected-source>
      {headingPath.length > 0 && (
        <span className="mb-0.5 block truncate text-xs text-cafe-muted">
          {part.kind === 'comment' ? '批注章节' : part.kind === 'quote' ? '引文内章节' : '章节'}：
          {headingPath.join(' › ')}
        </span>
      )}
      <div className="border-l-2 border-[var(--console-border-strong)] pl-2.5">
        {quotation && (
          <span className="block text-xs text-cafe-muted">
            {origin
              ? `引自 ${sourceSpeakerLabel(origin, resolveSpeaker)}（${sourceTime(origin.timestamp)}）`
              : `${speaker} 消息中的引用材料（未核实原出处作者）`}
          </span>
        )}
        {!!origin?.headingPath.length && (
          <span className="block truncate text-xs text-cafe-muted">原消息章节：{origin.headingPath.join(' › ')}</span>
        )}
        {part.kind === 'comment' && <span className="text-xs text-cafe-muted">{speaker} 当条批注：</span>}
        {/* Keep the source excerpt literal; it must not borrow the enclosing reply's dynamic reference projection. */}
        <ChatReferenceScope value={undefined}>
          <MarkdownContent
            content={`${prefix}${excerpt.text}${excerpt.truncatedAfter ? '…' : ''}`}
            disableCommandPrefix
            providerCitations={false}
            sourceHighlight={{ start: prefix.length + excerpt.quoteStart, end: prefix.length + excerpt.quoteEnd }}
            className="line-clamp-3 text-sm leading-[1.55] [&_p]:my-0 [&_p]:leading-[1.55] [&_ul]:my-0.5 [&_pre]:my-1"
          />
        </ChatReferenceScope>
        {selected.comment && part.kind !== 'comment' && (
          <span className="mt-1 block truncate text-xs leading-5 text-cafe-secondary">
            {speaker} 当条批注：「{selected.comment.text}
            {selected.comment.truncated ? '…' : ''}」
          </span>
        )}
      </div>
    </div>
  );
}
