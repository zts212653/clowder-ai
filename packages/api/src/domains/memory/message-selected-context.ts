import { type MarkdownHeadingAncestor, markdownHeadingPath } from '@cat-cafe/shared';
import type { MessageSourceTextPart } from './message-source-parts.js';

/** Preserve original UTF-16 context around the selected span, including adjacent conditions and negation. */
export function selectedMessageContext(text: string, start: number, end: number) {
  let left = Math.max(0, start - 650);
  let right = Math.min(text.length, end + 650);
  if (left > 0 && text.charCodeAt(left) >= 0xdc00 && text.charCodeAt(left) <= 0xdfff) left--;
  if (right < text.length && text.charCodeAt(right - 1) >= 0xd800 && text.charCodeAt(right - 1) <= 0xdbff) right++;
  return {
    text: text.slice(left, right),
    start: left,
    end: right,
    quoteStart: start - left,
    quoteEnd: end - left,
    truncatedBefore: left > 0,
    truncatedAfter: right < text.length,
  };
}

/** Publisher text blocks share heading ancestry; quoted text and code never manufacture publisher headings. */
export function selectedMessageHeadings(
  parts: MessageSourceTextPart[],
  selected: MessageSourceTextPart,
  before: number,
): string[] {
  if (selected.part.kind === 'code') return [];
  if (selected.part.kind === 'quote' || selected.part.kind === 'comment')
    return markdownHeadingPath(selected.text, before).map((heading) => heading.text);
  let path: MarkdownHeadingAncestor[] = [];
  for (const part of parts) {
    if (part.part.kind === 'body' || part.part.kind === 'text')
      path = markdownHeadingPath(part.text, part === selected ? before : part.text.length, path);
    if (part === selected) break;
  }
  return path.map((heading) => heading.text);
}
