/**
 * F167 Phase H AC-H1~H3/H5/H6 — Final routing slot syntax validator (pure function).
 *
 * 机械校验 final routing slot 里的 @ 语法：slot 内出现 inline @handle 但无合法出口
 * （行首 @ / hold_ball / MCP targetCats）→ invalid_route_syntax。
 *
 * 设计原则（KD-24，2026-04-24 铲屎官 + 砚砚 GPT-5.5 拍板）：
 * - 只判"出口槽位语法对不对"，不推断"猫想不想传球"（禁止语义 intent 分类器 / KD-8）
 * - 命中只产出 invalid_route_syntax，不自动路由 / 不推断目标 / 不替猫决定意图
 * - 豁免只走结构边界（fenced code / blockquote / URL），禁止动作词表 / 语义豁免表
 *
 * 与 verdict-detect.ts（AC-C7）同构，但更严格的纯机械判定，命中时 route-serial
 * 会 suppress AC-C7 + 既有 #417 inline-mention-hint（格式错是根因）。
 */

export interface ValidationInput {
  /** The cat's output text (stored content, post-stream). */
  readonly text: string;
  /** Line-start @mentions parsed from the text (typically a2aMentions). */
  readonly lineStartMentions: readonly string[];
  /** Tool names the cat invoked this turn. Checked for hold_ball presence. */
  readonly toolNames: readonly string[];
  /** CatIds routed via MCP tool payloads (post_message.targetCats + multi_mention.targets). */
  readonly structuredTargetCats: readonly string[];
  /** Roster handle whitelist (from cat-config). Non-roster @ mentions are ignored. */
  readonly rosterHandles: readonly string[];
}

export type ValidationResult =
  | { kind: 'ok' }
  | {
      kind: 'invalid_route_syntax';
      readonly inlineMentions: readonly string[];
      readonly slot: string;
    };

const MARKDOWN_LINE_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;
const URL_RE = /https?:\/\/[^\s)\]]+/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;

/**
 * Extract final routing slot = structurally-stripped last non-empty paragraph.
 *
 * Structural strip order:
 *   1. Remove fenced code blocks (``` ... ```)
 *   2. Remove blockquote lines (lines starting with '>')
 *   3. Remove URLs (http/https, leaving markdown link text if present)
 *
 * Then split by blank lines; return last non-empty paragraph trimmed.
 *
 * NOTE: segment metadata (tool output / cross-post body) is optional per AC-H1.
 * Current impl does markdown structural strip only. If metadata support is added
 * later (via optional param), this function's signature can be extended.
 */
export function finalRoutingSlot(text: string): string {
  if (!text) return '';

  const noFence = text.replace(FENCED_CODE_RE, '');

  const noQuote = noFence
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');

  const noUrl = noQuote.replace(URL_RE, '');

  const paragraphs = noUrl
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]! : '';
}

/**
 * Find inline @handle mentions in slot (= not at line-start position).
 *
 * Line-start = first non-whitespace char after optional markdown list/quote prefix
 * (e.g. "  - @codex" → line-start, "让 @codex" → inline).
 */
export function findInlineMentionsInSlot(slot: string, rosterHandles: readonly string[]): string[] {
  if (!slot || rosterHandles.length === 0) return [];

  // Accept handles with or without leading '@' (cat-config.mentionPatterns uses '@handle';
  // test / callsites may pass plain 'handle'). Normalize to plain + lowercase for
  // regex construction. Lowercase match is consistent with parseA2AMentions /
  // detectInlineActionMentions — otherwise `@Codex` (capitalized) would route-fail
  // but Phase H would miss it (cloud Codex P2 on PR #1381).
  const normalizedHandles = rosterHandles
    .map((h) => (h.startsWith('@') ? h.slice(1) : h).toLowerCase())
    .filter((h) => h.length > 0);
  if (normalizedHandles.length === 0) return [];
  const escaped = normalizedHandles.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const handleAlt = escaped.join('|');
  // Token boundary — both sides:
  //   - left (lookbehind): `@` must NOT be preceded by a handle-continuation char
  //     (a-z0-9_-). This rejects `foo@codex`, `user.codex@codex.ai` etc.
  //     (cloud Codex P2 round-2 on PR #1381).
  //   - right (lookahead): after handle, must be end-of-string or non-word char.
  // `i` flag: case-insensitive for ASCII (Chinese handles unaffected).
  const mentionRe = new RegExp(`(?<![a-zA-Z0-9_-])@(${handleAlt})(?=$|[^a-zA-Z0-9_-])`, 'gi');

  const inline: string[] = [];

  for (const line of slot.split(/\r?\n/)) {
    // Compute "line-start position" = length of leading whitespace + markdown prefix
    const leadingWsLen = (line.match(/^\s*/) ?? [''])[0]!.length;
    const afterLeadingWs = line.slice(leadingWsLen);
    const prefixMatch = afterLeadingWs.match(MARKDOWN_LINE_PREFIX_RE);
    const prefixLen = prefixMatch ? prefixMatch[0].length : 0;
    const lineStartPos = leadingWsLen + prefixLen;

    mentionRe.lastIndex = 0;
    let m: RegExpExecArray | null = mentionRe.exec(line);
    while (m !== null) {
      const idx = m.index;
      if (idx !== lineStartPos) {
        // Normalize captured handle to lowercase for consistency with parseA2AMentions.
        inline.push(m[1]!.toLowerCase());
      }
      m = mentionRe.exec(line);
    }
  }

  return inline;
}

/**
 * Main validator.
 *
 * Returns `ok` when ANY of:
 *   - legitimate line-start @mention present
 *   - hold_ball tool call present
 *   - structured MCP routing (targetCats / multi_mention targets) present
 *   - no inline @handle inside final routing slot
 *
 * Returns `invalid_route_syntax` when NONE of the above AND slot has inline @handle.
 */
export function validateRoutingSyntax(input: ValidationInput): ValidationResult {
  if (input.lineStartMentions.length > 0) return { kind: 'ok' };
  if (input.toolNames.some((n) => n.includes('cat_cafe_hold_ball'))) return { kind: 'ok' };
  if (input.structuredTargetCats.length > 0) return { kind: 'ok' };

  const slot = finalRoutingSlot(input.text);
  const inlineMentions = findInlineMentionsInSlot(slot, input.rosterHandles);
  if (inlineMentions.length === 0) return { kind: 'ok' };

  return { kind: 'invalid_route_syntax', inlineMentions, slot };
}
