/**
 * F075 Phase B — "笨蛋猫猫" silly stats computation
 * Keyword-based sentiment: distinguish 亲昵骂 (affectionate) from 真生气 (angry).
 * MVP: keyword matching + heuristics, no ML model.
 */
import type { SillyCatEntry, SillyStats } from '@cat-cafe/shared';
import type { MessageLike } from './mention-stats.js';

/** Angry scolding patterns — 真生气 */
const ANGRY_PATTERNS = [
  /你怎么又/,
  /我让你.*没让你/,
  /啊？[！!]{1,}/,
  /[！!]{3,}/, // ≥3 exclamation marks
  /你干嘛/,
  /怎么搞的/,
  /搞什么/,
];

/** Affectionate teasing — 亲昵, cancels anger if co-present */
const AFFECTION_PATTERNS = [/哈哈/, /😂|🤣|😹|😆/, /笨蛋/, /傻猫/, /小绿茶/, /心机小坏猫/];

function isAngry(content: string): boolean {
  const hasAnger = ANGRY_PATTERNS.some((p) => p.test(content));
  if (!hasAnger) return false;
  const hasAffection = AFFECTION_PATTERNS.some((p) => p.test(content));
  return !hasAffection;
}

export function computeSillyStats(messages: MessageLike[], catNames: Record<string, string>): SillyStats {
  const scoldCount = new Map<string, number>();

  for (const msg of messages) {
    // Only count user messages (catId === null) that scold mentioned cats
    if (msg.catId !== null) continue;
    if (!isAngry(msg.content)) continue;
    for (const catId of msg.mentions) {
      scoldCount.set(catId, (scoldCount.get(catId) ?? 0) + 1);
    }
  }

  const entries: SillyCatEntry[] = [...scoldCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([catId, count]) => ({
      catId,
      displayName: catNames[catId] ?? catId,
      label: '被骂最多 💀',
      description: '铲屎官发飙次数',
      count,
    }));

  return { entries };
}
