/**
 * Transcription corrector for voice input.
 *
 * ASR engines frequently misrecognize project-specific terms
 * (e.g. "MCP" → "ICP", "Fastify" → "法式的").  This module
 * provides a three-layer pipeline:
 *   1. Term dictionary replacement (case-insensitive)
 *   2. Chinese filler-word removal
 *   3. Whitespace collapse + trim
 */

import { escapeRegExp } from '@cat-cafe/shared';
import terms from './voice-terms.json';

export type TermEntry = readonly [RegExp, string];

/* ------------------------------------------------------------------ */
/*  1. Term dictionary                                                 */
/* ------------------------------------------------------------------ */

function buildTermEntries(dict: Record<string, string>): TermEntry[] {
  return Object.entries(dict)
    .filter(([k]) => !k.startsWith('_comment'))
    .map(([pattern, replacement]) => [new RegExp(escapeRegExp(pattern), 'gi'), replacement]);
}

const builtInEntries: ReadonlyArray<TermEntry> = buildTermEntries(terms as Record<string, string>);

/**
 * Merge built-in terms with user-defined custom terms (custom wins).
 * Keys are normalized to lowercase before merging so that custom "ICP"
 * correctly overrides built-in "icp" (regex matching is case-insensitive).
 */
export function mergeTermEntries(customTerms: ReadonlyArray<{ from: string; to: string }>): TermEntry[] {
  if (customTerms.length === 0) return [...builtInEntries];
  // Build lowercase-keyed dict from built-in terms
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(terms as Record<string, string>)) {
    if (!k.startsWith('_comment')) merged[k.toLowerCase()] = v;
  }
  // Custom terms override using lowercase key
  for (const { from, to } of customTerms) {
    if (from.trim()) merged[from.toLowerCase()] = to;
  }
  return buildTermEntries(merged);
}

// Keep backward-compatible module-level entries for existing callers
const termEntries: ReadonlyArray<TermEntry> = builtInEntries;

// ── Refreshable speech mention aliases ──────────────────
function buildSpeechMentionPattern(aliases: string[]): RegExp {
  if (aliases.length === 0) return /(?!)/g; // never-match fallback
  return new RegExp(
    `(^|\\s)(?:at|艾特|@\\s*[。｡\\.．])\\s*(?:咱的|我的)?\\s*(${aliases.map(escapeRegExp).join('|')})(?=$|\\s|[,.:;!?()\\[\\]{}<>，。！？、：；（）【】《》「」『』〈〉])`,
    'gi',
  );
}

// Starts empty; refreshSpeechAliases() populates after /api/cats fetch
let _speechMentionPattern = buildSpeechMentionPattern([]);

/** Refresh speech mention aliases from dynamic cat data (called by useCatData) */
export function refreshSpeechAliases(cats: Array<{ mentionPatterns: string[] }>): void {
  const aliases = Array.from(new Set(cats.flatMap((cat) => cat.mentionPatterns.map((p) => p.replace(/^@/, ''))))).sort(
    (a, b) => b.length - a.length,
  );
  _speechMentionPattern = buildSpeechMentionPattern(aliases);
}

/**
 * Normalize voice-recognized mention prefix:
 * "at 砚砚" / "艾特 宪宪" → "@砚砚" / "@宪宪"
 */
export function normalizeSpeechMentions(text: string): string {
  return text.replace(_speechMentionPattern, (_match, prefix: string, alias: string) => `${prefix}@${alias}`);
}

/**
 * Replace known misrecognized terms with their correct forms.
 * Matching is case-insensitive; unknown terms pass through unchanged.
 * Pass custom entries to override/extend the built-in dictionary.
 */
export function applyTermDictionary(text: string, entries?: ReadonlyArray<TermEntry>): string {
  let result = text;
  for (const [re, replacement] of entries ?? termEntries) {
    result = result.replace(re, replacement);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  2. Filler removal                                                  */
/* ------------------------------------------------------------------ */

/**
 * Chinese filler / hedge words that add no semantic value in a
 * technical instruction context.
 */
const FILLERS = ['就是说', '然后呢', '对对对', '那个', '就是', '嗯', '啊'];

const fillerPattern = new RegExp(FILLERS.map(escapeRegExp).join('|'), 'g');

/**
 * Remove common Chinese filler words, then collapse consecutive
 * whitespace and trim.
 */
export function removeFillers(text: string): string {
  return text.replace(fillerPattern, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/*  3. Full pipeline                                                   */
/* ------------------------------------------------------------------ */

/**
 * End-to-end correction: term dictionary → mention normalization → filler removal.
 * Pass merged entries (from mergeTermEntries) to use custom terms.
 */
export function correctTranscription(text: string, entries?: ReadonlyArray<TermEntry>): string {
  return removeFillers(normalizeSpeechMentions(applyTermDictionary(text, entries)));
}
