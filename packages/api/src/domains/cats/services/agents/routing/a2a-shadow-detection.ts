/**
 * clowder-ai#489: Shadow detection for inline @mention observability.
 *
 * Split from a2a-mentions.ts for file-size compliance.
 * Provides relaxed detection to identify "vocab gap" candidates -
 * inline @mentions with handoff-like context that strict regex missed.
 */

import { createHash } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../../../config/cat-config-loader.js';
import {
  AFTER_HANDOFF_RE,
  BEFORE_HANDOFF_RE,
  detectInlineActionMentions,
  HANDLE_CONTINUATION_RE,
  type InlineActionMention,
  TOKEN_BOUNDARY_RE,
} from './a2a-mentions.js';

interface MentionPatternEntry {
  readonly catId: CatId;
  readonly pattern: string;
}

/**
 * Relaxed action heuristic for shadow detection.
 * Superset of strict BEFORE/AFTER_HANDOFF_RE - catches broader patterns
 * that suggest handoff/request intent. Used to gate shadow misses so that
 * pure narrative mentions ("之前 @codex 提出的方案不错") are excluded.
 */
const RELAXED_BEFORE_ACTION_RE =
  /(?:ready\s+for|ask|ping|cc|let|need|交接给?|转给|(?<![邀申敬])请|帮|让|叫|问一?下?|找|麻烦|通知)\s*$/i;
const RELAXED_AFTER_ACTION_RE =
  /^\s*(?:(?:review|check|fix|merge|look|help|handle|test|verify)(?![a-z])|(?:确认|处理|来处理|来看|看一?下|看看)(?![过了完好掉])|帮忙|请(?![教示假求问])|修(?![改辞])|验证|负责|跟进)/i;

/** Shadow miss metadata — no raw text, per data minimization (mindfn #479). */
export interface ShadowMiss {
  readonly catId: CatId;
  /** SHA-256 of the line context, truncated to 16 hex chars. */
  readonly contextHash: string;
  /** Length of the raw line. */
  readonly contextLength: number;
}

export interface ShadowDetectionResult {
  readonly strictHits: InlineActionMention[];
  readonly shadowMisses: ShadowMiss[];
  /** Count of mentions skipped because routedSet already covered them. */
  readonly routedSetSkips: number;
}

function hashContext(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

/**
 * clowder-ai#489: Run strict detection + relaxed shadow detection in one pass.
 *
 * Shadow detection = "any inline @mention with relaxed action signal but not
 * caught by strict detection and not in routedSet". These are vocab gap
 * candidates - the user likely has handoff intent (per RELAXED_*_ACTION_RE)
 * but their wording isn't in the strict regex. Pure narrative mentions
 * (e.g. "之前 @codex 提出的方案不错") are excluded.
 */
export function detectInlineActionMentionsWithShadow(
  text: string,
  currentCatId?: CatId,
  routedMentions?: CatId[],
): ShadowDetectionResult {
  if (!text) return { strictHits: [], shadowMisses: [], routedSetSkips: 0 };

  const strictHits = detectInlineActionMentions(text, currentCatId, routedMentions);

  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const allConfigs = Object.keys(catRegistry.getAllConfigs()).length > 0 ? catRegistry.getAllConfigs() : CAT_CONFIGS;

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
  const shadowMisses: ShadowMiss[] = [];
  let routedSetSkips = 0;

  for (const rawLine of stripped.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    const normalized = trimmed.toLowerCase();
    if (normalized.startsWith('>')) continue;

    const lineShadowSeen = new Set<string>();
    const lineRoutedSkipSeen = new Set<string>();

    for (const entry of entries) {
      let searchFrom = 0;
      while (searchFrom < normalized.length) {
        const idx = normalized.indexOf(entry.pattern, searchFrom);
        if (idx < 0) break;
        searchFrom = idx + 1;
        if (idx === 0) continue; // line-start → handled by parseA2AMentions
        if (HANDLE_CONTINUATION_RE.test(normalized[idx - 1]!)) continue;
        const charAfter = normalized[idx + entry.pattern.length];
        const isBoundary = !charAfter || TOKEN_BOUNDARY_RE.test(charAfter) || !HANDLE_CONTINUATION_RE.test(charAfter);
        if (!isBoundary) continue;

        const before = normalized.slice(0, idx);
        const after = normalized.slice(idx + entry.pattern.length);
        const hasActionKeyword = BEFORE_HANDOFF_RE.test(before) || AFTER_HANDOFF_RE.test(after);

        if (routedSet.has(entry.catId)) {
          if (hasActionKeyword && !lineRoutedSkipSeen.has(entry.catId)) {
            lineRoutedSkipSeen.add(entry.catId);
            routedSetSkips++;
            break;
          }
          continue;
        }
        const hasRelaxedAction = RELAXED_BEFORE_ACTION_RE.test(before) || RELAXED_AFTER_ACTION_RE.test(after);
        if (!hasActionKeyword && hasRelaxedAction && !lineShadowSeen.has(entry.catId)) {
          lineShadowSeen.add(entry.catId);
          shadowMisses.push({
            catId: entry.catId,
            contextHash: hashContext(rawLine.trim()),
            contextLength: rawLine.trim().length,
          });
          break;
        }
        if (hasActionKeyword || hasRelaxedAction) {
          break;
        }
      }
    }
  }

  return { strictHits, shadowMisses, routedSetSkips };
}
