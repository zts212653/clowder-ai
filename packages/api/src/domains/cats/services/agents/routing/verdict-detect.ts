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

import { stripTrailingCatSignatures } from './cat-signature-strip.js';
import { finalRoutingSlot } from './final-routing-slot.js';

// 2026-06-20 verdict eval:a2a C2 void-hold English fix: signature stripping
// extracted to `cat-signature-strip.ts` so void-hold-detect.ts can share the
// same source of truth. See that module for the regex + helper.

/**
 * Review verdict 关键词。保守集，避免常见日常用语误报：
 * - 英文：LGTM / approved (past-tense only — see tuning note) / reject(ed) / P1: / P2:
 * - 中文：修改建议 / 放行 / 打回
 *
 * 故意不收录："通过"（"测试通过"类日常说法过多）、"approved by"（和"approved"重复）。
 *
 * Each pattern carries a stable telemetry name so the C2 counter can attribute which
 * keyword fired (F192 build verdict 2026-06-03: owner needs keyword-overload visibility
 * to decide whether to tune VERDICT_PATTERNS vs bypass specific thread kinds).
 *
 * **2026-06-05 keyword tuning (eval:a2a fix verdict)**: the build observability shipped
 * in #2058 produced a decisive breakdown — 19/19 fires were `thread_system_kind="product"`
 * (system-thread bypass hypothesis falsified) and 18/19 were `trigger="approve"|"p1p2"`
 * (keyword-overload hypothesis confirmed). Two surgical tightenings:
 *
 * 1. `approve`: was `/\bapprove(d|s)?\b/i`, now `/\bapproved\b/i`. Past-tense only — the
 *    strongest "decision made" signal. Drops bare `approve` / `approves`, which mostly
 *    show up as intent statements ("I approve this approach") or third-person narrative
 *    ("the team approves the design") rather than ball-dropping verdicts.
 * 2. `p1p2`: was `/\bP[12]\b/`, now `/\bP[12]\s*[:：]/`. Colon required — the classic
 *    verdict format (`P1: bug`, `P2: nit`). Drops bare mentions like `P1 already fixed`
 *    (status update), `P0/P1/P2 all clean` (list/summary), `PR review with P1 addressed`.
 *
 * Trade-off accepted: a few uncolon'd real verdicts ("found P1 in handler") will slip
 * through. If next eval shows ratio still elevated, re-tune (likely add classifier-context
 * fallback `P[12]\s+(?:finding|issue|bug|blocker|nit)`); if ratio crashes below floor and
 * real ball-drops escape, restore broader pattern. Reversible.
 */
const VERDICT_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'lgtm', pattern: /\bLGTM\b/i },
  { name: 'approve', pattern: /\bapproved\b/i },
  { name: 'reject', pattern: /\breject(ed|s)?\b/i },
  { name: 'p1p2', pattern: /\bP[12]\s*[:：]/ },
  { name: 'modify_suggestion', pattern: /修改建议/ },
  { name: 'approve_cn', pattern: /放行/ },
  { name: 'reject_cn', pattern: /打回/ },
] as const;

/**
 * Detect whether the output's **final routing slot** contains a review verdict keyword.
 *
 * 2026-06-16 actionable fix (砚砚 eval:a2a verdict
 * `2026-06-16-eval-a2a-c2-verdict-context-false-positive-fix`):
 * Previously this scanned the entire stored output text. The 06-16 eval showed
 * 6/89 = 6.7% false-positive ratio on `verdict_without_pass` because cats writing
 * status updates ("PR #X 已放行", "P1: foo 已修", "approved by Y") tripped the
 * keyword scan even though the message's actual final paragraph was a status
 * summary — no verdict was being **given** right then.
 *
 * Fix: scope detection to the **final routing slot** via `finalRoutingSlot()`
 * (same Phase H mechanism that scopes inline-@ detection — KD-24 mechanical, no
 * semantic classifier). Narrative body verdicts no longer fire; verdict-in-slot
 * still does. True positives where the cat genuinely ends with a verdict
 * (single-paragraph or multi-paragraph with verdict in last slot) are preserved.
 *
 * Trade-off: structural exemptions (fenced code / blockquote / URL) at the end
 * of the message strip the slot to the previous paragraph — see `finalRoutingSlot`
 * for the strip discipline. A verdict ONLY inside trailing fenced code (e.g.
 * pasted prior-cat output) is treated as quoted, not a new verdict — desired.
 */
export function hasReviewVerdict(text: string): boolean {
  if (!text) return false;
  const slot = finalRoutingSlot(stripTrailingCatSignatures(text));
  if (!slot) return false;
  return VERDICT_PATTERNS.some(({ pattern }) => pattern.test(slot));
}

/**
 * Return the stable name of the first verdict keyword that matches the **final
 * routing slot**, or `null` if none.
 *
 * Used as a telemetry attribute on the C2 verdict counters so an eval operator can
 * slice friction ratios by which keyword overloaded — e.g. distinguish a "p1p2"-driven
 * spike (review-discussion vocab) from a "放行"-driven one (real verdict-without-pass).
 *
 * 2026-06-16 fix (砚砚 eval:a2a verdict): scopes to the final routing slot for
 * consistency with `shouldWarnVerdictWithoutPass` — if the warning doesn't fire,
 * the trigger label should not surface either, and vice-versa.
 *
 * Pattern iteration order is the order in VERDICT_PATTERNS; do not rely on a particular
 * "most specific match" — it returns the first hit.
 */
export function detectMatchedVerdictKeyword(text: string): string | null {
  if (!text) return null;
  const slot = finalRoutingSlot(stripTrailingCatSignatures(text));
  if (!slot) return null;
  for (const { name, pattern } of VERDICT_PATTERNS) {
    if (pattern.test(slot)) return name;
  }
  return null;
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
   * mention (`@co-creator` / `@co-creator` / configured coCreator patterns). Caller computes
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
 *   5. No line-start co-creator mention (`@co-creator` / `@co-creator` — escalation to user)
 */
export function shouldWarnVerdictWithoutPass(input: VerdictWarningInput): boolean {
  if (!hasReviewVerdict(input.text)) return false;
  if (input.lineStartMentions.length > 0) return false;
  if (hasHoldBallCall(input.toolNames)) return false;
  if (input.structuredTargetCats.length > 0) return false;
  if (input.hasCoCreatorLineStartMention) return false;
  return true;
}
