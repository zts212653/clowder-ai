/**
 * F140 Phase E.1 — Strict severity parser (P0 / P1 / P2) with FP guards.
 *
 * Three accepted formats (any one match wins):
 *   1. shields.io badge: `img.shields.io/badge/P[0-2]-...`
 *   2. line-leading bracket: `^\[P[0-2]\]`
 *   3. line-leading colon: `^(**)?P[0-2](**)?:`
 *
 * FP guards (砚砚 GPT-5.4 KD-16 + GPT-5.5 P1-1):
 *   - Strip fenced code blocks first (so `P1:` in a code sample doesn't trigger)
 *   - Strip blockquote lines first (so `> P1:` quoting an old finding doesn't trigger)
 *   - ALL formats scanned on cleaned body only — badge included, to prevent the
 *     "过期 P1/P2 冒出来" structural regression when a blockquote quotes an old
 *     Codex badge.
 *   - Bare `P1` inside a sentence is not recognized (no leading `[`, `:`, or badge context).
 *   - P3 is informational — not surfaced in the header.
 */

export type Severity = 'P0' | 'P1' | 'P2';

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

// Global flags — must find ALL markers in a body, not first hit
// (云端 codex P0 2026-04-24: single body with multiple severities was
// downgraded to the first regex hit; now we scan exhaustively and pick max.)
const BADGE_REGEX = /img\.shields\.io\/badge\/(P[0-2])-/g;
const BRACKET_REGEX = /^\s*\[(P[0-2])\](?=\s|$)/gm;
const COLON_REGEX = /^\s*(?:\*\*)?(P[0-2])(?:\*\*)?:/gm;

/** Strip fenced code blocks + blockquote lines before severity match. */
function stripNoise(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

export function parseSeverity(body: string): Severity | null {
  if (!body) return null;

  const cleaned = stripNoise(body);

  // 云端 codex P0 2026-04-24 修正：scan ALL markers across all three formats,
  // then pick max. First-hit return was downgrading multi-severity bodies
  // (e.g. `[P2] ...\n**P0**: ...` returned P2 because bracket regex hits before
  // colon). getMaxSeverity at the aggregate layer couldn't mask this — findings
  // often live in one comment body (inline Codex review style).
  let max: Severity | null = null;
  const consider = (s: Severity): void => {
    if (!max || SEVERITY_RANK[s] < SEVERITY_RANK[max]) max = s;
  };

  BADGE_REGEX.lastIndex = 0;
  BRACKET_REGEX.lastIndex = 0;
  COLON_REGEX.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = BADGE_REGEX.exec(cleaned)) !== null) consider(m[1] as Severity);
  while ((m = BRACKET_REGEX.exec(cleaned)) !== null) consider(m[1] as Severity);
  while ((m = COLON_REGEX.exec(cleaned)) !== null) consider(m[1] as Severity);

  return max;
}

export function getMaxSeverity(
  comments: readonly { body: string }[],
  decisions: readonly { body: string }[],
): Severity | null {
  let max: Severity | null = null;
  const consider = (s: Severity | null): void => {
    if (!s) return;
    if (!max || SEVERITY_RANK[s] < SEVERITY_RANK[max]) max = s;
  };
  for (const c of comments) consider(parseSeverity(c.body));
  for (const d of decisions) consider(parseSeverity(d.body));
  return max;
}
