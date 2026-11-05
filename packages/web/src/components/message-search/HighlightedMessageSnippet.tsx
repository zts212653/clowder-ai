import type { MessageSearchResult } from '@cat-cafe/shared';
import { Fragment } from 'react';

/** Keep canonical evidence intact; two-line presentation must never rewrite the excerpt. */
export function HighlightedMessageSnippet({ result }: { result: MessageSearchResult }) {
  return <HighlightedMessageText text={result.snippet.text} ranges={result.highlights} />;
}

export function HighlightedMessageText({
  text,
  ranges: input,
  focusOffset,
}: {
  text: string;
  ranges: Array<{ start: number; end: number }>;
  focusOffset?: number;
}) {
  const ranges = input
    .filter(
      (range) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= text.length,
    )
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  const pieces = ranges.map((range) => {
    if (range.start < cursor || range.start >= text.length) return null;
    const start = cursor;
    cursor = range.end;
    return (
      <Fragment key={`${range.start}:${range.end}`}>
        {text.slice(start, range.start)}
        <mark
          data-message-search-focus={
            focusOffset !== undefined && range.start <= focusOffset && focusOffset < range.end ? true : undefined
          }
          className="rounded bg-[var(--accent-100)] text-cafe-black"
        >
          {text.slice(range.start, cursor)}
        </mark>
      </Fragment>
    );
  });
  return (
    <>
      {pieces}
      {text.slice(cursor)}
    </>
  );
}
