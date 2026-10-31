import { Children, type ReactNode } from 'react';

export function countReaderMatches(content: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;

  const haystack = content.toLocaleLowerCase();
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function highlightString(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;

  const lowerText = text.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lowerText.indexOf(lowerNeedle);

  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index));
    parts.push(
      <mark key={`${index}-${cursor}`} className="rounded bg-cafe-accent/20 px-0.5 text-cafe">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    cursor = index + needle.length;
    index = lowerText.indexOf(lowerNeedle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

export function highlightReaderText(children: ReactNode, query: string): ReactNode {
  if (typeof children === 'string') return highlightString(children, query);
  return Children.map(children, (child) => (typeof child === 'string' ? highlightString(child, query) : child));
}
