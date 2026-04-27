/**
 * F167 C2 AC-C7 — Harness-layer review verdict detection.
 *
 * 检测猫猫输出里是否给了 review-style 结论（approve/reject/LGTM/P1/P2/修改建议 等）
 * 但没传球（无行首 @ + 没调 hold_ball）——这种"结论 + 球掉地上"是 F167 目标场景之一。
 *
 * 设计原则：
 * - Prompt-first、非阻断：仅用于提示，不影响链路。
 * - 保守关键词：只匹配明确 review 语义的信号词（"通过/拒绝"因与日常用法重叠过多不列入）。
 * - 纯函数：route-serial 层负责调用 + 广播连接器消息。
 *
 * 与 Phase A 乒乓球警告同属 harness 安全网；prompt 层规则（AC-C5/C6）在 exit check 与
 * shared-rules §10 已落地，本模块是不依赖猫配合的兜底信号。
 */

/**
 * Review verdict 关键词。保守集，避免常见日常用语误报：
 * - 英文：LGTM / approve(d) / reject(ed) / P1 / P2
 * - 中文：修改建议 / 放行 / 打回
 *
 * 故意不收录："通过"（"测试通过"类日常说法过多）、"approved by"（和"approve"重复）。
 */
const VERDICT_PATTERNS: readonly RegExp[] = [
  /\bLGTM\b/i,
  /\bapprove(d|s)?\b/i,
  /\breject(ed|s)?\b/i,
  /\bP[12]\b/,
  /修改建议/,
  /放行/,
  /打回/,
] as const;

/**
 * Detect whether the output text contains a review verdict keyword.
 *
 * Scope: output text only. No context awareness (quotations, code blocks not excluded)
 * because the warning is prompt-first non-blocking — occasional false positives are
 * acceptable and won't break link routing.
 */
export function hasReviewVerdict(text: string): boolean {
  if (!text) return false;
  return VERDICT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Detect whether the collected tool names include a hold_ball MCP call.
 *
 * Accepts provider-wrapped names (e.g. `mcp__cat-cafe__cat_cafe_hold_ball`) by substring
 * match on `cat_cafe_hold_ball`.
 */
export function hasHoldBallCall(toolNames: readonly string[]): boolean {
  if (!toolNames || toolNames.length === 0) return false;
  return toolNames.some((name) => name.includes('cat_cafe_hold_ball'));
}

export interface VerdictWarningInput {
  /** The cat's output text (stored content, post-stream). */
  readonly text: string;
  /** Line-start @mentions parsed from the text (typically a2aMentions). */
  readonly lineStartMentions: readonly string[];
  /** Tool names the cat invoked during this turn (typically collectedToolNames). */
  readonly toolNames: readonly string[];
  /**
   * CatIds routed to via MCP tool payloads this turn
   * (`cat_cafe_post_message.targetCats` + `cat_cafe_multi_mention.targets`).
   * Present = structured routing occurred = legitimate ball-pass via MCP.
   */
  readonly structuredTargetCats: readonly string[];
  /**
   * 2026-04-25 (砚砚 GPT-5.5 fix): true iff text has a line-start co-creator
   * mention (`@co-creator` / `@铲屎官` / configured coCreator patterns). Caller computes
   * via `detectUserMention(text)`. parseA2AMentions only knows cat handles, so
   * without this flag a cat ending its summary report with `@co-creator` (legitimate
   * pass to co-creator) was being flagged as "verdict without pass".
   */
  readonly hasCoCreatorLineStartMention?: boolean;
}

/**
 * Decide whether to emit the harness-layer "verdict without ball-pass" warning.
 *
 * Triggers iff ALL of the following:
 *   1. Output contains a verdict keyword
 *   2. No line-start @cat mention (would otherwise route the ball via text)
 *   3. No hold_ball MCP call (would otherwise be an explicit intentional hold)
 *   4. No structured MCP routing (post_message.targetCats / multi_mention.targets)
 *   5. No line-start co-creator mention (`@co-creator` / `@铲屎官` — escalation to user)
 */
export function shouldWarnVerdictWithoutPass(input: VerdictWarningInput): boolean {
  if (!hasReviewVerdict(input.text)) return false;
  if (input.lineStartMentions.length > 0) return false;
  if (hasHoldBallCall(input.toolNames)) return false;
  if (input.structuredTargetCats.length > 0) return false;
  if (input.hasCoCreatorLineStartMention) return false;
  return true;
}
