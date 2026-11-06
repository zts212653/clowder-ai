/**
 * A2A Mention Detection
 * 从猫回复文本中检测对其他猫的 @mention。
 *
 * 规则 (F046 简化 — 行首即路由):
 * 1. 剥离围栏代码块 (```...```) 后再解析
 * 2. 仅匹配行首 mention（可带前导空白）→ 直接路由，无需动作词
 * 3. 长匹配优先 + token boundary，避免 `@opus-45` 误命中 `@opus`
 * 4. 过滤自调用
 * 5. F27: 返回所有匹配的猫 (上限 MAX_A2A_MENTION_TARGETS)
 * 6. 只在猫回复完整结束后解析 (由调用方保证)
 *
 * 1–3 的语法在 @cat-cafe/shared 的 findLineStartMentions（聊天里的方向徽章读同一份）；
 * 这里决定有哪些句柄（自调用、停用猫）和最多几个目标。
 */

import type { CatId, CatRoutingError } from '@cat-cafe/shared';
import {
  catRegistry,
  findLineStartMentions,
  HANDLE_CONTINUATION_RE,
  MAX_A2A_MENTION_TARGETS,
  TOKEN_BOUNDARY_RE,
} from '@cat-cafe/shared';
import { isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { resolveCatTarget } from './cat-target-resolver.js';

/** Max A2A chain depth, configurable via env (read at call time for hot-reload) */
export function getMaxA2ADepth(): number {
  return Number(process.env.MAX_A2A_DEPTH) || 15;
}

/** @internal Re-exported for a2a-shadow-detection.ts; the grammar lives in @cat-cafe/shared. */
export { HANDLE_CONTINUATION_RE, TOKEN_BOUNDARY_RE };

interface MentionPatternEntry {
  readonly catId: CatId;
  readonly pattern: string;
}

export interface A2AMentionAnalysis {
  readonly mentions: CatId[];
  /** F182: routing errors for disabled cats detected in text @ parsing */
  readonly routing_warnings: CatRoutingError[];
}

/** #417: Inline @mention paired with action words — missed handoff candidate. */
export interface InlineActionMention {
  readonly catId: CatId;
  readonly lineText: string;
}

/**
 * Parse A2A @mentions from cat response text.
 * F27: Returns all matched CatIds (up to MAX_A2A_MENTION_TARGETS).
 *
 * Line-start @mention = always actionable. No keyword gate.
 */
export function parseA2AMentions(text: string, currentCatId?: CatId): CatId[] {
  return analyzeA2AMentions(text, currentCatId).mentions;
}

export function analyzeA2AMentions(text: string, currentCatId?: CatId): A2AMentionAnalysis {
  // F32-a: read from catRegistry (.cat-cafe/cat-catalog.json)
  const allConfigs = catRegistry.getAllConfigs();

  // F182 KD-10: include ALL cats (including disabled) so patterns participate in matching;
  // availability is checked at match-time via resolveCatTarget, not here.
  const handles: MentionPatternEntry[] = [];
  for (const [id, config] of Object.entries(allConfigs)) {
    if (currentCatId && id === currentCatId) continue; // Filter self (skip when cross-thread)
    for (const pattern of config.mentionPatterns) {
      handles.push({ catId: id as CatId, pattern: pattern.toLowerCase() });
    }
  }

  const found: CatId[] = [];
  const seen = new Set<string>();
  const routing_warnings: CatRoutingError[] = [];
  for (const catId of findLineStartMentions(text, handles) as CatId[]) {
    if (found.length >= MAX_A2A_MENTION_TARGETS) break; // F27 safety limit
    if (seen.has(catId)) continue;
    seen.add(catId);
    // F182 KD-10: resolver check at match-time (not at pattern-build time)
    const resolved = resolveCatTarget(catId);
    if ('error' in resolved) routing_warnings.push(resolved.error);
    else found.push(catId);
  }

  return { mentions: found, routing_warnings };
}

/**
 * #417: Detect inline @mentions paired with action words — missed handoff candidates.
 * Used for write-side feedback only, NOT for routing.
 *
 * Conditions (all must hold):
 *  1. @pattern appears mid-line (not at line start)
 *  2. Action keyword immediately adjacent to @mention (proximity-based, not whole-line)
 *  3. Not inside a fenced code block or blockquote
 *  4. Target cat was not already routed via line-start mention
 *  5. Not a self-mention
 */

/**
 * Action patterns that appear immediately BEFORE @mention (e.g. "Ready for @xxx").
 * Chinese 请 uses negative lookbehind to exclude compounds (邀请 = invite, 申请 = apply).
 */
/** @internal Exported for a2a-shadow-detection.ts. */
export const BEFORE_HANDOFF_RE = /(?:ready\s+for|交接给?|转给|(?<![邀申敬])请|帮)\s*$/i;
/**
 * Action patterns immediately AFTER @mention (e.g. "@xxx review").
 * English verbs use (?![a-z]) to reject continuations ("reviewed", "checklist").
 * Chinese verbs use negative lookahead to exclude completion suffixes (过/了/完/好/掉).
 */
/** @internal Exported for a2a-shadow-detection.ts. */
export const AFTER_HANDOFF_RE =
  /^\s*(?:(?:review|check|fix|merge)(?![a-z])|(?:确认|处理|来处理|来看)(?![过了完好掉])|看一?下|帮忙|请(?![教示假求问]))/i;

export function detectInlineActionMentions(
  text: string,
  currentCatId?: CatId,
  routedMentions?: CatId[],
): InlineActionMention[] {
  if (!text) return [];

  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const allConfigs = catRegistry.getAllConfigs();

  const entries: MentionPatternEntry[] = [];
  for (const [id, config] of Object.entries(allConfigs)) {
    if (currentCatId && id === currentCatId) continue;
    if (!isCatAvailable(id)) continue;
    for (const pattern of config.mentionPatterns) {
      entries.push({ catId: id as CatId, pattern: pattern.toLowerCase() });
    }
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length);

  const routedSet = new Set(routedMentions ?? []);
  const found: InlineActionMention[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripped.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    const normalized = trimmed.toLowerCase();
    // Skip blockquotes; do NOT skip lines starting with @ — the inner loop's
    // routedSet handles line-start mentions, so other inline @ on the same line
    // can still be detected (P1 fix from codex review of cat-cafe#1057).
    if (normalized.startsWith('>')) continue;

    let lineMatched = false;
    for (const entry of entries) {
      if (lineMatched) break;
      // Scan ALL occurrences of this pattern in the line (not just first indexOf hit).
      // Fixes: "之前 @codex 提过意见，现在 Ready for @codex review" must find the second one.
      let searchFrom = 0;
      while (searchFrom < normalized.length) {
        const idx = normalized.indexOf(entry.pattern, searchFrom);
        if (idx < 0) break;
        searchFrom = idx + 1;
        // Skip line-start mentions — those are handled by parseA2AMentions, not here.
        // Only skip this specific occurrence, not the whole line (P1 fix: other cats
        // on the same line may still be inline action mentions).
        if (idx === 0) continue;
        // Left boundary: @ must not be preceded by word-like chars (avoids "foo@codex")
        if (HANDLE_CONTINUATION_RE.test(normalized[idx - 1]!)) continue;
        const charAfter = normalized[idx + entry.pattern.length];
        const isBoundary = !charAfter || TOKEN_BOUNDARY_RE.test(charAfter) || !HANDLE_CONTINUATION_RE.test(charAfter);
        if (!isBoundary) continue;
        // Already routed via line-start: skip this entry but keep scanning other cats on same line.
        if (routedSet.has(entry.catId)) break;
        const before = normalized.slice(0, idx);
        const after = normalized.slice(idx + entry.pattern.length);
        if (!BEFORE_HANDOFF_RE.test(before) && !AFTER_HANDOFF_RE.test(after)) continue;
        if (!seen.has(entry.catId)) {
          seen.add(entry.catId);
          found.push({ catId: entry.catId, lineText: rawLine.trim() });
          lineMatched = true;
        }
        // Already-seen cat: don't claim the line — let other cats still be scanned.
        break;
      }
    }
  }

  return found;
}

// --- clowder-ai#489: Shadow detection — extracted to a2a-shadow-detection.ts ---
export type { ShadowDetectionResult, ShadowMiss } from './a2a-shadow-detection.js';
export { detectInlineActionMentionsWithShadow } from './a2a-shadow-detection.js';
