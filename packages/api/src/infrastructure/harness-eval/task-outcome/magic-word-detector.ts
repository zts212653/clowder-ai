/**
 * F192 Phase G AC-G12 — Magic Word runtime detection.
 *
 * Detects magic words (operator-only emergency brake words) in user messages.
 * These are "intention interrupts" — the user expresses dissatisfaction
 * with the cat's direction, not just a mechanical button press.
 *
 * The word list is hardcoded here (not parsed from shared-rules.md at runtime)
 * because: (1) shared-rules parsing is compile-time in governance-l0.ts,
 * (2) the word list changes rarely, (3) runtime regex is simpler and faster.
 *
 * Source of truth for magic words: shared-rules.md §Magic Words table.
 */

export interface MagicWordHit {
  word: string;
  /** Index in the original message where the word was found */
  index: number;
}

/**
 * Static magic word patterns from shared-rules.md.
 * Each entry is the word inside「」brackets.
 */
export const MAGIC_WORD_PATTERNS: readonly string[] = [
  '脚手架',
  '绕路了',
  '喵约',
  '星星罐子',
  '第一性原理',
  '数学之美',
  '下次一定',
  '我能猜出来',
  '碎片够了',
  '补锅匠',
];

/**
 * Detect magic words in a user message.
 * Returns all hits with their positions. Order matches appearance in message.
 */
export function detectMagicWords(message: string): MagicWordHit[] {
  if (!message) return [];

  const hits: MagicWordHit[] = [];
  for (const word of MAGIC_WORD_PATTERNS) {
    let startIdx = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: indexOf loop pattern
    while ((startIdx = message.indexOf(word, startIdx)) !== -1) {
      hits.push({ word, index: startIdx });
      startIdx += word.length;
    }
  }

  // Sort by position in message
  hits.sort((a, b) => a.index - b.index);
  return hits;
}
