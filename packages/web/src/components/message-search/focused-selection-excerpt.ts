import type { MessageSourceSelection } from '@cat-cafe/shared';

/** Keep the selected paragraphs and whole qualifying sentences; never invent a new source range. */
export function extractFocusedSelectionExcerpt(context: MessageSourceSelection['context']) {
  const { text, quoteStart, quoteEnd } = context;
  let start = 0,
    end = text.length;
  for (const gap of text.matchAll(/\n\s*\n/gu)) {
    if (gap.index + gap[0].length <= quoteStart) start = gap.index + gap[0].length;
    if (gap.index >= quoteEnd) {
      end = gap.index;
      break;
    }
  }
  if (quoteStart - start > 120) {
    const prefix = text.slice(start, quoteStart);
    const boundaries = [...prefix.matchAll(/[。！？!?\n]|\.(?=\s|$)/gu)];
    const last = boundaries.at(-1);
    if (last) start += last.index + 1;
  }
  if (end - quoteEnd > 120) {
    const next = /[。！？!?\n]|\.(?=\s|$)/u.exec(text.slice(quoteEnd, end));
    if (next) end = quoteEnd + next.index + 1;
  }
  return {
    text: text.slice(start, end),
    quoteStart: quoteStart - start,
    quoteEnd: quoteEnd - start,
    truncatedBefore: context.truncatedBefore || start > 0,
    truncatedAfter: context.truncatedAfter || end < text.length,
  };
}
