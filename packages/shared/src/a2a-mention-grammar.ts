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
export const HANDLE_CONTINUATION_RE = /[a-z0-9_./-]|\\/;
const LEADING_MARKDOWN_MENTION_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;
const LINE_START_MARKDOWN_PREFIX_PATTERN = String.raw`\s*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))*`;
// A slash can end a handle when another mention follows immediately.
const HANDLE_BOUNDARY_PATTERN = String.raw`(?=$|[/\\]@|${TOKEN_BOUNDARY_RE.source}|[^a-z0-9_./\\-])`;
const HANDLE_END_BOUNDARY_RE = new RegExp(`^${HANDLE_BOUNDARY_PATTERN}`);

export interface MentionHandle {
  readonly catId: string;
  /** Lowercase handle including the leading `@`. */
  readonly pattern: string;
}

export function isReservedGroupMentionHandle(handle: string): boolean {
  return /^@(?:all(?:-.+)?|全体.*|thread|本帖)$/u.test(handle);
}

/** Explicit aliases keep their owners when a stable ID would collide. */
export function buildCatMentionHandles(
  cats: readonly { id: string; mentionPatterns: readonly string[] }[],
  reserved: readonly string[] = [],
  onCollision?: (catId: string, handle: string, holder?: string) => void,
): MentionHandle[] {
  const explicit = new Map<string, string>();
  for (const cat of cats) {
    if (cat.id === '__none__') continue;
    for (const pattern of cat.mentionPatterns) {
      const normalized = pattern.toLowerCase();
      if (!explicit.has(normalized)) explicit.set(normalized, cat.id);
    }
  }
  const handles = Array.from(explicit, ([pattern, catId]) => ({ catId, pattern }));
  const occupied = new Set(reserved.map((pattern) => pattern.toLowerCase()));
  for (const { id } of cats) {
    if (id === '__none__') continue;
    const pattern = `@${id.toLowerCase()}`;
    const holder = explicit.get(pattern);
    if (holder === id) continue;
    if (holder || occupied.has(pattern) || isReservedGroupMentionHandle(pattern)) {
      onCollision?.(id, pattern, holder);
      continue;
    }
    handles.push({ catId: id, pattern });
    occupied.add(pattern);
  }
  return handles;
}

/** Cat ids of the line-start mentions in `text`, in order of appearance (repeats included). */
export function findLineStartMentions(
  text: string,
  handles: readonly MentionHandle[],
  onUnknown?: (segment: string) => void,
): string[] {
  if (!text) return [];
  const entries = [...handles].sort((a, b) => b.pattern.length - a.pattern.length);
  const normalizedText = repairLineStartMentionWhitespace(text.replace(/```[\s\S]*?```/g, ''), entries);
  return normalizedText.split(/\r?\n/).flatMap((line) => readLineStartHandles(line, entries, onUnknown));
}

/** The run of handles a line opens with; the first unknown handle or prose ends it. */
function readLineStartHandles(
  rawLine: string,
  entries: readonly MentionHandle[],
  onUnknown?: (segment: string) => void,
): string[] {
  const line = rawLine.trimStart().toLowerCase().replace(LEADING_MARKDOWN_MENTION_PREFIX_RE, '');
  const found: string[] = [];
  let cursor = 0;
  while (line.charAt(cursor) === '@') {
    const segment = line.slice(cursor);
    const entry = entries.find((candidate) => startsWithMentionHandle(segment, candidate.pattern));
    if (!entry) {
      onUnknown?.(segment);
      break;
    }
    found.push(entry.catId);
    cursor += entry.pattern.length;
    while (cursor < line.length && TOKEN_BOUNDARY_RE.test(line.charAt(cursor))) cursor += 1;
  }
  return found;
}

export function startsWithMentionHandle(segment: string, pattern: string): boolean {
  return segment.startsWith(pattern) && isMentionHandleEndBoundary(segment, pattern.length);
}

export function isMentionHandleEndBoundary(text: string, end: number): boolean {
  return HANDLE_END_BOUNDARY_RE.test(text.slice(end));
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
