/**
 * F227 PR-2 Task 5 — Magic Word confidence grading (deterministic, no-classifier).
 *
 * Layers a confidence tier (high/mid/low) on top of the F192 deterministic
 * substring detector, serving ONLY the 人工拉闸 (human-brake) lane of the
 * backfill. It does NOT infer cat intent (KD-3 no-classifier red line) — it
 * applies deterministic, auditable context rules:
 *
 *   1. cat-authored magic word          → low   magic words are operator-only brake
 *                                                words (L0 家规); a cat using one
 *                                                is quoting/discussing, never braking
 *   2. >=3 distinct words, or 「word」=def → low   discussion / listing / defining the
 *                                                table (the SNR-22% noise opus-47
 *                                                surfaced in eval: an RFC listing the
 *                                                magic-word range)
 *   3. cocreator + @cat mention         → high  a brake directed at a specific cat
 *   4. cocreator, otherwise             → mid   present but ambiguous
 *
 * The 10-word table stays single-sourced in the F192 detector (AC-A5: no dup).
 */

import type { EventConfidence } from '@cat-cafe/shared';
import {
  detectMagicWords,
  MAGIC_WORD_PATTERNS,
  type MagicWordHit,
} from '../../infrastructure/harness-eval/task-outcome/magic-word-detector.js';

export interface GradedMagicWordHit extends MagicWordHit {
  confidence: EventConfidence;
}

export interface GradeOptions {
  /**
   * True if the message was authored by the cocreator (co-creator). Magic words are
   * operator-only brake words — a cat authoring one is quoting/discussing, not braking.
   * Defaults to grading as cocreator-authored when authorship is unknown.
   */
  authoredByCocreator?: boolean;
}

/**
 * An @cat-handle mention. Email-safe: the `@` must not follow a local-part char,
 * so `foo@bar.com` is not mistaken for a mention, while `？@opus` / ` @opus` are.
 */
const CAT_MENTION_RE = /(?<![\w.%+-])@[A-Za-z][A-Za-z0-9_-]*/;

/**
 * A magic word wrapped in 「」 immediately followed by a definition marker —
 * i.e. the word is being DEFINED (家规/RFC), not invoked as a brake.
 */
const DEFINITION_RE = new RegExp(
  `「(?:${MAGIC_WORD_PATTERNS.join('|')})」\\s*(?:[=＝:：]|就是|指的是|指|表示|意思是|的意思)`,
);

function computeConfidence(message: string, hits: MagicWordHit[], opts: GradeOptions): EventConfidence {
  // Rule 1: a cat using a operator-only magic word is discussing/quoting, never braking.
  if (opts.authoredByCocreator === false) return 'low';
  // Rule 2: discussion/definition context — listing the table or defining a word.
  const distinct = new Set(hits.map((h) => h.word)).size;
  if (distinct >= 3) return 'low';
  if (DEFINITION_RE.test(message)) return 'low';
  // Rule 3: a brake directed at a specific cat.
  if (CAT_MENTION_RE.test(message)) return 'high';
  // Rule 4: present but ambiguous.
  return 'mid';
}

/** Grade pre-detected hits (used by the backfill, which already ran detectMagicWords). */
export function gradeMagicWordHits(
  message: string,
  hits: MagicWordHit[],
  opts: GradeOptions = {},
): GradedMagicWordHit[] {
  if (hits.length === 0) return [];
  const confidence = computeConfidence(message, hits, opts);
  return hits.map((hit) => ({ ...hit, confidence }));
}

/** Detect magic words in a message and grade each by confidence. */
export function detectGradedMagicWords(message: string, opts: GradeOptions = {}): GradedMagicWordHit[] {
  return gradeMagicWordHits(message, detectMagicWords(message), opts);
}
