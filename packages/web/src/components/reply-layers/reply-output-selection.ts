import {
  findGeneratedTextConstructs,
  type MarkdownReadableProjection,
  projectMarkdownReadableTextWithSourceMap,
} from '@cat-cafe/shared';
import type { ReplyOutputText } from './reply-output';

// Ephemeral render evidence only; canonical content and permissions remain owned by the message.
const sources = new WeakMap<Element, ReplyOutputText>();
export function registerReplyOutputSelectionSource(element: Element, run: ReplyOutputText): void {
  sources.set(element, run);
}
export function hasReplyOutputSelectionSource(element: Element): boolean {
  return sources.has(element);
}

function normalize(projection: MarkdownReadableProjection): MarkdownReadableProjection {
  let text = '';
  const sourceOffsets: (number | null)[] = [];
  let space = false;
  for (let index = 0; index < projection.text.length; index++) {
    const character = projection.text.charAt(index);
    if (/\s/u.test(character)) {
      space = text.length > 0;
      continue;
    }
    if (space) {
      text += ' ';
      sourceOffsets.push(null);
      space = false;
    }
    text += character;
    sourceOffsets.push(projection.sourceOffsets[index] ?? null);
  }
  return { text, sourceOffsets };
}

/** A unique selected range inside this attested native slice, mapped to full stored-content UTF16. */
export function replyOutputSelectionOffsets(
  element: Element,
  selectedText: string,
): { start: number; end: number } | null {
  const run = sources.get(element);
  if (!run || findGeneratedTextConstructs(run.text).length) return null;
  const projection = normalize(projectMarkdownReadableTextWithSourceMap(run.text));
  const text = selectedText.trim().replace(/\s+/gu, ' ');
  if (!text) return null;
  const index = projection.text.indexOf(text);
  if (index < 0 || projection.text.indexOf(text, index + 1) !== -1) return null;
  const first = projection.sourceOffsets[index];
  const last = projection.sourceOffsets[index + text.length - 1];
  if (first === null || first === undefined || last === null || last === undefined) return null;
  const start = run.start + first,
    end = run.start + last + 1;
  return start >= run.start && end <= run.end && end > start ? { start, end } : null;
}
