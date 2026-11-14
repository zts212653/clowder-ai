/**
 * A2A @mention grammar (F046 — 行首即路由): which handles in a message are routing targets.
 *
 * 1. Fenced code blocks (```...```) are stripped first.
 * 2. Only line-start mentions count (leading whitespace and markdown quote/list prefixes allowed).
 * 3. Longest handle wins, and a handle must end on a token boundary (`@opus-45` never matches `@opus`).
 * 4. A line may list several handles; once prose starts, later inline mentions on that line do not count.
 *
 * Callers decide which handles exist (self, availability) and how many targets to keep;
 * the API router and the chat display both read targets through this one grammar.
 */

import { escapeRegExp } from './text-utils.js';

/** Max number of distinct cats a single message can @mention (F27 safety limit). */
export const MAX_A2A_MENTION_TARGETS = 2;

export const TOKEN_BOUNDARY_RE = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;
export const HANDLE_CONTINUATION_RE = /[a-z0-9_.-]/;
const LEADING_MARKDOWN_MENTION_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;
const LINE_START_MARKDOWN_PREFIX_PATTERN = String.raw`\s*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))*`;
const HANDLE_BOUNDARY_PATTERN = String.raw`(?=$|[\s,.:;!?()\[\]{}<>，。！？、：；（）【】《》「」『』〈〉]|[^a-z0-9_.-])`;

export interface MentionHandle<Id extends string = string> {
  readonly catId: Id;
  /** Lowercase handle including the leading `@`. */
  readonly pattern: string;
  readonly stableIdFallback?: true;
}

/** Keep configured aliases in their original order and add IDs that have no competing handle. */
export function buildCatMentionHandles<Id extends string>(
  cats: readonly { id: Id; mentionPatterns?: readonly string[] }[],
  reserved: readonly string[],
): MentionHandle<Id>[] {
  const handles: MentionHandle<Id>[] = cats.flatMap(({ id, mentionPatterns }) =>
    (mentionPatterns ?? []).map((pattern) => ({ catId: id, pattern: pattern.toLowerCase() })),
  );
  const occupied = new Set(reserved.map((pattern) => pattern.toLowerCase()));
  for (const { pattern } of handles) occupied.add(pattern);
  for (const { id } of cats) {
    const pattern = `@${id.toLowerCase()}`;
    if (pattern === '@__none__' || /^@(?:all(?:-.+)?|全体.*|thread|本帖)$/u.test(pattern) || occupied.has(pattern)) {
      continue;
    }
    handles.push({ catId: id, pattern, stableIdFallback: true });
    occupied.add(pattern);
  }
  return handles;
}

/** Keep newly routable IDs out of package/path text. Slash-separated mentions are still valid. */
export function isMentionPathSuffix(text: string, end: number): boolean {
  const charAfter = text[end];
  return (charAfter === '/' || charAfter === '\\') && text[end + 1] !== '@';
}

/** Cat ids of the line-start mentions in `text`, in order of appearance (repeats included). */
export function findLineStartMentions(text: string, handles: readonly MentionHandle[]): string[] {
  if (!text) return [];
  const entries = [...handles].sort((a, b) => b.pattern.length - a.pattern.length);
  const normalizedText = repairLineStartMentionWhitespace(text.replace(/```[\s\S]*?```/g, ''), entries);
  return normalizedText.split(/\r?\n/).flatMap((line) => readLineStartHandles(line, entries));
}

/** The run of handles a line opens with; the first unknown handle or prose ends it. */
function readLineStartHandles(rawLine: string, entries: readonly MentionHandle[]): string[] {
  const line = rawLine.trimStart().toLowerCase().replace(LEADING_MARKDOWN_MENTION_PREFIX_RE, '');
  const found: string[] = [];
  let cursor = 0;
  while (line.charAt(cursor) === '@') {
    const segment = line.slice(cursor);
    const entry = entries.find(
      (candidate) => segment.startsWith(candidate.pattern) && endsOnBoundary(segment, candidate),
    );
    if (!entry) break;
    found.push(entry.catId);
    cursor += entry.pattern.length;
    while (cursor < line.length && TOKEN_BOUNDARY_RE.test(line.charAt(cursor))) cursor += 1;
  }
  return found;
}

function endsOnBoundary(segment: string, entry: MentionHandle): boolean {
  if (entry.stableIdFallback && isMentionPathSuffix(segment, entry.pattern.length)) return false;
  const charAfter = segment[entry.pattern.length];
  return !charAfter || TOKEN_BOUNDARY_RE.test(charAfter) || !HANDLE_CONTINUATION_RE.test(charAfter);
}

function buildWhitespaceTolerantMentionPattern(pattern: string): RegExp {
  const interleaved = Array.from(pattern)
    .map((ch) => escapeRegExp(ch))
    .join(String.raw`\s*`);
  return new RegExp(`(^|\\n)(${LINE_START_MARKDOWN_PREFIX_PATTERN})${interleaved}${HANDLE_BOUNDARY_PATTERN}`, 'giu');
}

function repairLineStartMentionWhitespace(text: string, entries: readonly MentionHandle[]): string {
  let repaired = text;
  for (const entry of entries) {
    repaired = repaired.replace(
      buildWhitespaceTolerantMentionPattern(entry.pattern),
      (_match, lineStart: string, prefix: string) => `${lineStart}${prefix}${entry.pattern}`,
    );
  }
  return repaired;
}
