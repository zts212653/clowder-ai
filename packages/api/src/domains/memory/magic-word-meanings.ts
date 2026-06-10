/**
 * F227 PR-2 Task 8 (AC-A5) — magic-word meanings sourced from L0, not redefined.
 *
 * The compiled governance L0 (from cat-cafe-skills/refs/shared-rules.md, via
 * loadCompiledGovernanceL0Sync) projects each magic word as a line:
 *   -「脚手架」= 你在偷懒写临时方案 → 停，审视产物是否终态…
 * We parse those lines into structured {word, meaning, action} so the timeline's
 * meaning popover reads from the single source of truth. No hardcoded word table.
 */

export interface MagicWordMeaning {
  word: string;
  meaning: string;
  action: string;
}

// `-「word」= meaning → action`. The meaning has no →; the first ` → ` splits it
// from the action (the action itself may contain an inner → like "不是→重写").
const MEANING_LINE_RE = /^-\s*「([^」]+)」\s*=\s*(.+?)\s*→\s*(.+?)\s*$/;

/** Parse magic-word meanings from the compiled L0 content (single source = L0). */
export function parseMagicWordMeanings(compiledL0Content: string): MagicWordMeaning[] {
  const out: MagicWordMeaning[] = [];
  for (const line of compiledL0Content.split('\n')) {
    const m = MEANING_LINE_RE.exec(line);
    if (m?.[1] && m[2] && m[3]) {
      out.push({ word: m[1], meaning: m[2], action: m[3] });
    }
  }
  return out;
}
