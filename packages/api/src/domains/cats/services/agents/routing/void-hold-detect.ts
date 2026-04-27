/**
 * F167 Phase I AC-I1~I3 — 虚空持球检测 (Void Hold Detection).
 *
 * 检测猫的回复文本声明"持球"但本轮 tool_calls 不含 cat_cafe_hold_ball。
 * 这是声明-动作一致性检查（KD-25），不是语义分类器（KD-8 safe）。
 *
 * 结构剥离复用 Phase H 的逻辑：fenced code / blockquote / URL 内的关键词不触发。
 */

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s)\]]+/g;

const HOLD_PATTERNS: readonly RegExp[] = [
  /持球/,
  /\bhold.ball\b/i,
  /\bhold_ball\b/i,
  /\bholding.the.ball\b/i,
  /我.*持.*球/,
  /cat_cafe_hold_ball/,
] as const;

function stripStructural(text: string): string {
  const noFence = text.replace(FENCED_CODE_RE, '');
  const noQuote = noFence
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return noQuote.replace(URL_RE, '');
}

export function hasHoldTextClaim(text: string): boolean {
  if (!text) return false;
  const stripped = stripStructural(text);
  return HOLD_PATTERNS.some((p) => p.test(stripped));
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

export function shouldWarnVoidHold(input: VoidHoldInput): boolean {
  if (!hasHoldTextClaim(input.text)) return false;
  if (hasHoldBallToolCall(input.toolNames)) return false;
  if (input.lineStartMentions.length > 0) return false;
  if (input.structuredTargetCats.length > 0) return false;
  if (input.hasCoCreatorLineStartMention) return false;
  return true;
}
