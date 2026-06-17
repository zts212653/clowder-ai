/**
 * F167 Phase I AC-I1~I3 — 虚空持球检测 (Void Hold Detection).
 *
 * 检测猫的回复文本声明"持球"但本轮 tool_calls 不含 cat_cafe_hold_ball。
 * 这是声明-动作一致性检查（KD-25），不是语义分类器（KD-8 safe）。
 *
 * 结构剥离复用 Phase H 的逻辑：fenced code / blockquote / URL 内的关键词不触发。
 *
 * F192 Phase D — eval:a2a 2026-06-10 build verdict: `evaluateVoidHold` returns
 * the matched HOLD_PATTERN id as `trigger` so per-fire sample evidence can bucket
 * fires by surface phrase (parallel to verdict-detect returning matched verdict
 * keyword). `shouldWarnVoidHold` is preserved as a backward-compatible shim.
 */

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s)\]]+/g;

/**
 * Hold pattern catalog. Order matters: more-specific patterns first so a
 * multi-pattern match (e.g. "我现在持着球" hits both /持球/ via substring and
 * /我.*持.*球/) attributes to the more informative trigger. Iteration
 * short-circuits on first hit.
 *
 * Trigger ids are stable wire-format strings; downstream attribution buckets
 * fires by these strings. Renaming an id is a breaking change for eval
 * dashboards / classification — bump a new id rather than renaming.
 */
export interface HoldPatternEntry {
  readonly id: string;
  readonly re: RegExp;
}

export const HOLD_PATTERNS: readonly HoldPatternEntry[] = [
  // Most-specific first ↓
  { id: 'mcp_tool_name', re: /cat_cafe_hold_ball/ },
  { id: 'en_hold_ball_underscore', re: /\bhold_ball\b/i },
  { id: 'en_holding_the_ball', re: /\bholding.the.ball\b/i },
  { id: 'en_holdball_space', re: /\bhold.ball\b/i },
  { id: 'cn_wo_chi_qiu', re: /我.*持.*球/ },
  // Least-specific last ↓ (bare 持球 substring)
  { id: 'cn_chiqiu', re: /持球/ },
] as const;

/** Stable id list for downstream test contracts and attribution allowlists. */
export const HOLD_PATTERN_IDS: readonly string[] = HOLD_PATTERNS.map((p) => p.id);

function stripStructural(text: string): string {
  const noFence = text.replace(FENCED_CODE_RE, '');
  const noQuote = noFence
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return noQuote.replace(URL_RE, '');
}

/**
 * Returns the matched HOLD_PATTERN id (most-specific first) or null if no hold
 * surface phrase is found in the structurally-stripped text. Used by both
 * `hasHoldTextClaim` (boolean shim) and `evaluateVoidHold` (trigger capture).
 */
export function matchHoldPattern(text: string): string | null {
  if (!text) return null;
  const stripped = stripStructural(text);
  for (const entry of HOLD_PATTERNS) {
    if (entry.re.test(stripped)) return entry.id;
  }
  return null;
}

export function hasHoldTextClaim(text: string): boolean {
  return matchHoldPattern(text) !== null;
}

function hasHoldBallToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => name.includes('cat_cafe_hold_ball'));
}

export interface VoidHoldInput {
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly lineStartMentions: readonly string[];
  readonly structuredTargetCats: readonly string[];
  readonly hasCoCreatorLineStartMention?: boolean;
}

export interface VoidHoldEvaluation {
  /** True iff the void-hold-hint should fire (caller emits the connector + counter). */
  readonly shouldEmit: boolean;
  /**
   * Matched HOLD_PATTERN id when text claims hold — preserved even when
   * `shouldEmit=false` (suppressed by exit / actual tool call). Tells telemetry
   * which surface phrase the cat wrote, separate from whether emission fired.
   * Null only when no hold phrase appeared at all.
   */
  readonly matchedPattern: string | null;
}

/**
 * Full evaluation: returns both emission decision and matched trigger.
 * Emission is suppressed if any legitimate exit is present (hold_ball tool,
 * line-start @cat / co-creator mention, or structured MCP routing).
 */
export function evaluateVoidHold(input: VoidHoldInput): VoidHoldEvaluation {
  const matched = matchHoldPattern(input.text);
  if (matched === null) return { shouldEmit: false, matchedPattern: null };
  if (hasHoldBallToolCall(input.toolNames)) return { shouldEmit: false, matchedPattern: matched };
  if (input.lineStartMentions.length > 0) return { shouldEmit: false, matchedPattern: matched };
  if (input.structuredTargetCats.length > 0) return { shouldEmit: false, matchedPattern: matched };
  if (input.hasCoCreatorLineStartMention) return { shouldEmit: false, matchedPattern: matched };
  return { shouldEmit: true, matchedPattern: matched };
}

/**
 * Backward-compatible shim: boolean form preserved for callers that don't need
 * the matched trigger. Equivalent to `evaluateVoidHold(input).shouldEmit`.
 */
export function shouldWarnVoidHold(input: VoidHoldInput): boolean {
  return evaluateVoidHold(input).shouldEmit;
}
