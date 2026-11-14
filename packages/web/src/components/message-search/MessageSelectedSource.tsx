import type { MessageSearchResult } from '@cat-cafe/shared';
import { HighlightedMessageText } from './HighlightedMessageSnippet';
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
  return (
    <span className="block min-w-0 text-sm leading-6 text-cafe-secondary" data-message-selected-source>
      {headingPath.length > 0 && (
        <span className="mb-0.5 block text-xs text-cafe-muted">
          {part.kind === 'comment' ? '批注章节' : part.kind === 'quote' ? '引文内章节' : '章节'}：
          {headingPath.join(' › ')}
        </span>
      )}
      <span className={quotation ? 'block border-l-2 border-[var(--console-border-soft)] pl-2.5' : 'block'}>
        {quotation && (
          <span className="block text-xs text-cafe-muted">
            {origin
              ? `引自 ${sourceSpeakerLabel(origin, resolveSpeaker)} 的消息（${sourceTime(origin.timestamp)}，原消息与引文已核）：`
              : `${speaker} 消息中的引用材料（仅核实存在于本条转引，未核实原出处作者）：`}
          </span>
        )}
        {!!origin?.headingPath.length && (
          <span className="block text-xs text-cafe-muted">原消息章节：{origin.headingPath.join(' › ')}</span>
        )}
        {part.kind === 'comment' && quotation && (
          <span className="block break-words">
            「{quotation.text}
            {quotation.truncated ? '…' : ''}」
          </span>
        )}
        <span className="block whitespace-pre-wrap break-words">
          {part.kind === 'comment' ? `${speaker} 当条批注：「` : quotation ? '「' : ''}
          {context.truncatedBefore ? '…' : ''}
          <HighlightedMessageText text={context.text} ranges={[{ start: context.quoteStart, end: context.quoteEnd }]} />
          {context.truncatedAfter ? '…' : ''}
          {quotation ? '」' : ''}
        </span>
        {selected.comment && part.kind !== 'comment' && (
          <span className="mt-1 block text-xs leading-5 text-cafe-secondary">
            {speaker} 当条批注：「{selected.comment.text}
            {selected.comment.truncated ? '…' : ''}」
          </span>
        )}
      </span>
    </span>
  );
}
