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
 */

import type { CatId, CatRoutingError } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { buildAmbiguousCandidates, groupRoutingTokenHolders, resolveCatTarget } from './cat-target-resolver.js';
import {
  isMetricEligibleOutcome,
  type RoutingAttemptBatch,
  RoutingAttemptCollector,
  type RoutingAttemptOutcome,
  type RoutingTokenSpan,
} from './routing-attempt.js';

/** Max A2A chain depth, configurable via env (read at call time for hot-reload) */
export function getMaxA2ADepth(): number {
  return Number(process.env.MAX_A2A_DEPTH) || 15;
}

/** Max number of distinct cats a single message can @mention (F27 safety limit) */
const MAX_A2A_MENTION_TARGETS = 2;
/** @internal Exported for a2a-shadow-detection.ts. */
export const TOKEN_BOUNDARY_RE = /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;
/** @internal Exported for a2a-shadow-detection.ts. */
export const HANDLE_CONTINUATION_RE = /[a-z0-9_.-]/;
const LEADING_MARKDOWN_MENTION_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;
const LINE_START_MARKDOWN_PREFIX_PATTERN = String.raw`\s*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))*`;
const HANDLE_BOUNDARY_PATTERN = String.raw`(?=$|[\s,.:;!?()\[\]{}<>，。！？、：；（）【】《》「」『』〈〉]|[^a-z0-9_.-])`;

interface MentionPatternEntry {
  readonly catId: CatId;
  readonly pattern: string;
  /** F257 T-A 改造①: self patterns participate in matching, flagged instead of removed. */
  readonly isSelf?: boolean;
  /**
   * F257 #1: all holders when the pattern is shared by >1 cat — the token is
   * ambiguous and evaluateA2AToken refuses to resolve it (no guessing, not
   * even "is it me?": ambiguity beats self_excluded).
   */
  readonly contenders?: readonly CatId[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWhitespaceTolerantMentionPattern(pattern: string): RegExp {
  const interleaved = Array.from(pattern)
    .map((ch) => escapeRegExp(ch))
    .join(String.raw`\s*`);
  return new RegExp(`(^|\\n)(${LINE_START_MARKDOWN_PREFIX_PATTERN})${interleaved}${HANDLE_BOUNDARY_PATTERN}`, 'giu');
}

function repairLineStartMentionWhitespace(text: string, entries: readonly MentionPatternEntry[]): string {
  let repaired = text;
  for (const entry of entries) {
    repaired = repaired.replace(
      buildWhitespaceTolerantMentionPattern(entry.pattern),
      (_match, lineStart: string, prefix: string) => `${lineStart}${prefix}${entry.pattern}`,
    );
  }
  return repaired;
}

export interface A2AMentionAnalysis {
  readonly mentions: CatId[];
  /** F182: routing errors for disabled cats detected in text @ parsing */
  readonly routing_warnings: CatRoutingError[];
  /** F257 V1: per-token routing attempt drafts — semantics per T-A (§3.4). */
  readonly attemptBatch: RoutingAttemptBatch;
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
  const collector = new RoutingAttemptCollector();
  if (!text) {
    return { mentions: [], routing_warnings: [], attemptBatch: collector.finalize('a2a', 'a2a_normalized') };
  }

  // 1. Strip fenced code blocks
  const stripped = text.replace(/```[\s\S]*?```/g, '');

  // 2. Build patterns and sort longest-first to avoid prefix collisions
  // F182 KD-10: include ALL cats (including disabled) so patterns participate in matching;
  // availability is checked at match-time via resolveCatTarget, not here.
  // F257 T-A 改造①: self patterns stay in the set (flagged) so self tokens are
  // tokenized instead of aborting the line scan.
  // F257 #1: group by normalized pattern (catRegistry via groupRoutingTokenHolders) —
  // a multi-holder pattern stays matchable but carries `contenders` so
  // evaluateA2AToken refuses to guess a target (ambiguity beats self-exclusion).
  const entries: MentionPatternEntry[] = [];
  for (const [patternKey, holders] of groupRoutingTokenHolders()) {
    const isSelf = currentCatId !== undefined && holders.length === 1 && holders[0] === currentCatId;
    entries.push(
      holders.length === 1
        ? { catId: holders[0], pattern: patternKey, isSelf }
        : { catId: holders[0], pattern: patternKey, isSelf: false, contenders: holders },
    );
  }
  entries.sort((a, b) => b.pattern.length - a.pattern.length);
  const normalizedText = repairLineStartMentionWhitespace(stripped, entries);

  // 3. Line-start matching with token boundary — always actionable (no keyword gate)
  const state: A2AScanState = {
    entries,
    found: [],
    seen: new Set<string>(),
    routingWarnings: [],
    collector,
    capReached: false,
    truncated: false,
  };
  let lineStart = 0;
  while (lineStart <= normalizedText.length) {
    // split(/\r?\n/) semantics: lines end at \n, an immediately preceding \r joins the separator
    const sepIndex = normalizedText.indexOf('\n', lineStart);
    const lineEnd =
      sepIndex < 0
        ? normalizedText.length
        : sepIndex > lineStart && normalizedText[sepIndex - 1] === '\r'
          ? sepIndex - 1
          : sepIndex;
    scanA2ARouteLine(normalizedText.slice(lineStart, lineEnd), lineStart, state);
    if (state.truncated || sepIndex < 0) break;
    lineStart = sepIndex + 1;
  }

  return {
    mentions: state.found,
    routing_warnings: state.routingWarnings,
    attemptBatch: collector.finalize('a2a', 'a2a_normalized', { truncated: state.truncated }),
  };
}

interface A2AScanState {
  readonly entries: readonly MentionPatternEntry[];
  readonly found: CatId[];
  readonly seen: Set<string>;
  readonly routingWarnings: CatRoutingError[];
  readonly collector: RoutingAttemptCollector;
  /** 5. Safety limit hit — scan continues read-only (T-A 右截断 row). */
  capReached: boolean;
  truncated: boolean;
}

function scanA2ARouteLine(rawLine: string, lineOffset: number, state: A2AScanState): void {
  const leadingWs = rawLine.match(/^\s*/)?.[0].length ?? 0;
  const lowered = rawLine.slice(leadingWs).toLowerCase();
  const normalized = lowered.replace(LEADING_MARKDOWN_MENTION_PREFIX_RE, '');
  if (!normalized.startsWith('@')) return;
  const tokenBase = lineOffset + leadingWs + (lowered.length - normalized.length);

  let cursor = 0;
  while (cursor < normalized.length) {
    const segment = normalized.slice(cursor);
    const entry = matchA2AEntryAt(segment, state.entries);

    if (!entry) {
      // T-A 改造②: tokenize the unmatched token (@ up to the next boundary)
      // before abandoning the rest of the line (existing break preserved).
      const length = a2aUnknownTokenLength(segment);
      emitA2AAttempt(state, 'unknown_token', segment.slice(0, length), {
        start: tokenBase + cursor,
        end: tokenBase + cursor + length,
      });
      return;
    }

    const outcome = evaluateA2AToken(entry, state);
    emitA2AAttempt(
      state,
      outcome,
      entry.pattern,
      { start: tokenBase + cursor, end: tokenBase + cursor + entry.pattern.length },
      // F257 #1: an ambiguous token has multiple holders — no single target
      // (validator contract: target present iff outcome is single-target).
      outcome === 'ambiguous' ? undefined : entry.catId,
    );
    if (state.truncated) return;

    cursor += entry.pattern.length;
    while (cursor < normalized.length && TOKEN_BOUNDARY_RE.test(normalized[cursor]!)) {
      cursor += 1;
    }
    if (normalized[cursor] !== '@') return;
  }
}

function matchA2AEntryAt(segment: string, entries: readonly MentionPatternEntry[]): MentionPatternEntry | null {
  for (const entry of entries) {
    if (!segment.startsWith(entry.pattern)) continue;
    const charAfter = segment[entry.pattern.length];
    const isBoundary = !charAfter || TOKEN_BOUNDARY_RE.test(charAfter) || !HANDLE_CONTINUATION_RE.test(charAfter);
    if (!isBoundary) continue;
    return entry; // longest-match-first: entries are sorted, first hit wins
  }
  return null;
}

/** Token length from `@` up to the next boundary char (T-A 改造② token extraction). */
function a2aUnknownTokenLength(segment: string): number {
  let end = 1;
  while (end < segment.length && !TOKEN_BOUNDARY_RE.test(segment[end]!)) {
    end += 1;
  }
  return end;
}

/**
 * Applies routing effects (found/seen/warnings — unchanged behavior) unless the
 * cap was reached, and returns the T-A outcome for the token. Outcome names map
 * 1:1 to T-A parserMode=a2a rows; priority order is the table's row order.
 */
function evaluateA2AToken(entry: MentionPatternEntry, state: A2AScanState): RoutingAttemptOutcome {
  // F257 #1 (dev-628ea4d1): multi-holder pattern → refuse to route, surface the
  // holders' unambiguous handles. Checked before self-exclusion — with several
  // holders we do not even guess whether the author meant themselves.
  if (entry.contenders && entry.contenders.length > 1) {
    if (!state.capReached) {
      const alreadyWarned = state.routingWarnings.some(
        (w) => w.kind === 'mention_ambiguous' && w.mention === entry.pattern,
      );
      if (!alreadyWarned) {
        state.routingWarnings.push({
          kind: 'mention_ambiguous',
          mention: entry.pattern,
          candidates: buildAmbiguousCandidates(entry.contenders),
        });
      }
    }
    return 'ambiguous';
  }
  if (entry.isSelf) return 'self_excluded';
  // F182 KD-10: resolver check at match-time (not at pattern-build time)
  const resolved = resolveCatTarget(entry.catId);
  if ('error' in resolved) {
    if (!state.capReached && !state.seen.has(entry.catId)) {
      state.seen.add(entry.catId);
      state.routingWarnings.push(resolved.error);
    }
    return 'disabled_cat';
  }
  if (state.seen.has(entry.catId)) return 'duplicate';
  if (!state.capReached) {
    state.seen.add(entry.catId);
    state.found.push(entry.catId);
  }
  return 'resolved';
}

/**
 * Live mode: record the draft and flip to read-only once the resolve cap is hit.
 * Read-only mode (T-A 右截断 row): no drafts, no routing effects — the first
 * metric-affecting token confirms real truncation and invalidates the batch.
 */
function emitA2AAttempt(
  state: A2AScanState,
  outcome: RoutingAttemptOutcome,
  token: string,
  span: RoutingTokenSpan,
  targetCatId?: CatId,
): void {
  if (state.capReached) {
    if (isMetricEligibleOutcome(outcome)) state.truncated = true;
    return;
  }
  state.collector.add(span, token, outcome, targetCatId);
  if (state.found.length >= MAX_A2A_MENTION_TARGETS) state.capReached = true;
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
