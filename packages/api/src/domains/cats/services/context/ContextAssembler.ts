/**
 * Context Assembler
 * 从 messageStore 历史消息组装上下文字符串，prepend 到猫的 prompt 中。
 * 解决跨猫历史不可见问题 (猫咖狼人杀 bug report 的核心修复)。
 *
 * formatMessage() 也被 export route 复用 (聊天记录导出)。
 */

import { catRegistry, isCrossThreadProvenance } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../utils/token-counter.js';
import { formatPromptTime } from '../format-time.js';
import { isDelivered, type StoredMessage } from '../stores/ports/MessageStore.js';

export interface ContextAssemblerOptions {
  /** Invocation-owned token ceiling for the already-selected history. */
  maxTotalTokens?: number;
}

export interface AssembledContext {
  /** Formatted context string to prepend to prompt */
  contextText: string;
  /** Number of messages included */
  messageCount: number;
  /** Estimated token count of contextText (F8: for budget tracking) */
  estimatedTokens: number;
}

const DEFAULT_MAX_TOTAL_TOKENS = 2000;
/** Injection-safety bound, not a per-member prompt policy. */
const PROMPT_MESSAGE_SAFETY_CHAR_LIMIT = 100_000;
/** #699: Max chars for inline reply-to preview (saves agents a get_message tool call) */
const REPLY_PREVIEW_LENGTH = 60;

/**
 * Build a lookup map from message array for O(1) replyTo resolution.
 * Used by formatMessage to inline reply-to previews.
 */
export function buildMessageMap(messages: readonly StoredMessage[]): ReadonlyMap<string, StoredMessage> {
  const map = new Map<string, StoredMessage>();
  for (const m of messages) {
    map.set(m.id, m);
  }
  return map;
}

/**
 * Get display name for a message sender.
 * catId === null → user ("co-creator"), otherwise look up catRegistry.
 * For variant cats (e.g. sonnet, opus-45), includes variantLabel to distinguish same-family members.
 */
export function getSenderName(catId: string | null): string {
  if (catId === null) return 'co-creator';
  const entry = catRegistry.tryGet(catId);
  const config = entry?.config;
  if (!config) return catId;
  const variantLabel = config.variantLabel?.trim();
  if (!variantLabel) return config.displayName;
  if (config.displayName.toLowerCase().includes(variantLabel.toLowerCase())) {
    return config.displayName;
  }
  return `${config.displayName}(${variantLabel})`;
}

/**
 * Sanitize an external display name for safe embedding in prompt history
 * headers. Strips characters that could break the `[timestamp sender] content`
 * format or spoof other speakers:
 *  - Line breaks (`\n`, `\r`, U+2028, U+2029) → space
 *  - Brackets (`[`, `]`) → removed
 *  - C0/C1 control chars (U+0000–U+001F except \t, U+007F–U+009F) → removed
 */
function sanitizeDisplaySegment(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\n\r\u2028\u2029]/g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    .trim();
}

/**
 * Get display name for a connector source, including individual sender
 * for group chat messages. Without sender info (p2p / system), falls
 * back to source.label as before.
 *
 * Format: `SenderName via Label` (group) | `Label` (p2p/system)
 */
export function getSourceDisplayName(source: { label: string; sender?: { id: string; name?: string } }): string {
  const safeLabel = sanitizeDisplaySegment(source.label);
  if (source.sender) {
    const name = sanitizeDisplaySegment(source.sender.name || source.sender.id);
    return `${name} via ${safeLabel}`;
  }
  return safeLabel;
}

/**
 * Truncate content preserving both head and tail.
 * Head gets 40% of budget, tail gets 60% (conclusions/requests live at the end).
 * Marker includes dropped char count so the cat knows how much was lost.
 */
function truncateHeadTail(content: string, limit: number): string {
  const dropped = content.length - limit;
  const marker = `\n\n[...truncated ${dropped} chars...]\n\n`;
  const available = limit - marker.length;
  if (available <= 0) return content.slice(0, limit);
  const headSize = Math.floor(available * 0.4);
  const tailSize = available - headSize;
  return content.slice(0, headSize) + marker + content.slice(-tailSize);
}

/**
 * Format a single message for display.
 * Shared by context assembly (with truncation) and export (without truncation).
 *
 * @returns `[timestamp 角色名] 内容`
 */
export function formatMessage(
  msg: StoredMessage,
  options?: {
    truncate?: number;
    formatTime?: (epochMs: number) => string;
    /** #699: Message lookup map for inline reply-to preview */
    messageMap?: ReadonlyMap<string, StoredMessage>;
    /** #699 P2: Sanitizer for parent content before inlining preview (prevents injection via quoted text) */
    sanitizeContent?: (content: string) => string;
  },
): string {
  // Default formatter: UTC (formatPromptTime) for prompt injection — cats need
  // to align with external UTC sources. Non-prompt consumers (e.g. user-facing
  // export route) pass their own formatter to avoid leaking UTC into documents
  // whose header/footer use host-local time.
  const time = (options?.formatTime ?? formatPromptTime)(msg.timestamp);
  const sender = msg.source ? getSourceDisplayName(msg.source) : getSenderName(msg.catId);
  // F52: Annotate cross-thread messages with source thread
  const sourceThreadId = msg.extra?.crossPost?.sourceThreadId;
  const crossPostTag = isCrossThreadProvenance(sourceThreadId, msg.threadId)
    ? ` ← from thread:${sourceThreadId.slice(0, 8)}`
    : '';

  // #699: Inline reply-to preview — saves agents a get_message tool call.
  // Only resolves when messageMap is provided and the parent is in scope.
  let replyPrefix = '';
  if (msg.replyTo && options?.messageMap) {
    const parent = options.messageMap.get(msg.replyTo);
    if (parent) {
      const parentSender = parent.source ? getSourceDisplayName(parent.source) : getSenderName(parent.catId);
      const sanitized = options?.sanitizeContent ? options.sanitizeContent(parent.content) : parent.content;
      const raw = sanitized.replaceAll('\n', ' ');
      const preview = raw.length > REPLY_PREVIEW_LENGTH ? `${raw.slice(0, REPLY_PREVIEW_LENGTH)}…` : raw;
      replyPrefix = `[↩ ${parentSender}: ${preview}] `;
    }
  }

  let content = msg.content;
  if (options?.truncate && content.length > options.truncate) {
    content = truncateHeadTail(content, options.truncate);
  }
  return `[${time} ${sender}${crossPostTag}] ${replyPrefix}${content}`;
}

/**
 * Assemble recent thread history into a context string for prompt prepend.
 */
export function assembleContext(messages: StoredMessage[], options?: ContextAssemblerOptions): AssembledContext {
  const maxTotalTokens = options?.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;

  // F117: exclude undelivered messages (queued/canceled) from prompt context
  // Also exclude system-generated messages (userId='system') — these are display-only
  // (e.g. persisted error badges) and must not re-enter the prompt as "co-creator" messages.
  // #699: exclude briefing messages (origin='briefing') — non-routing internal artifacts
  // that must not appear in prompt context or reply preview maps (consistent with
  // isEligibleReplyParent and incremental context paths which already exclude them).
  // Defense: also exclude legacy error messages that were incorrectly persisted with
  // userId=user by route-parallel.ts (context poisoning bug, fixed in PR #992).
  // Only filter cat messages (catId !== null) starting with [错误] — user messages are legit.
  // All 6 known contaminated records start with [错误] (no partial-text-before-error exists
  // in practice, since stream_idle_stall means zero text was produced before the error).
  const deliveredMessages = messages.filter(
    (m) =>
      isDelivered(m) &&
      m.userId !== 'system' &&
      m.origin !== 'briefing' &&
      !(m.catId && m.content?.startsWith('[错误]')),
  );

  if (deliveredMessages.length === 0) {
    return { contextText: '', messageCount: 0, estimatedTokens: 0 };
  }

  // #699: Build message map for inline reply-to preview resolution.
  // Use deliveredMessages (not raw input) so system/undelivered/error parents
  // can't leak into prompt via formatMessage's inline preview.
  const messageMap = buildMessageMap(deliveredMessages);

  // Format all messages, then apply token budget from most-recent backward
  // Candidate selection belongs to Smart Window / the route. This assembler only
  // formats those candidates and enforces the invocation-owned token ceiling.
  const formatted = deliveredMessages.map((m) =>
    formatMessage(m, { truncate: PROMPT_MESSAGE_SAFETY_CHAR_LIMIT, messageMap }),
  );

  // Estimate overhead for header + separator
  const overheadTokens = estimateTokens('[对话历史 - 最近 99 条]\n[/对话历史]');

  let totalTokens = overheadTokens;
  let startIndex = formatted.length; // will walk backward
  for (let i = formatted.length - 1; i >= 0; i--) {
    const lineTokens = estimateTokens(`${formatted[i] ?? ''}\n`);
    if (totalTokens + lineTokens > maxTotalTokens) break;
    totalTokens += lineTokens;
    startIndex = i;
  }

  const included = formatted.slice(startIndex);
  if (included.length === 0) {
    return { contextText: '', messageCount: 0, estimatedTokens: 0 };
  }

  const header = `[对话历史 - 最近 ${included.length} 条]`;
  const contextText = `${header}\n${included.join('\n')}\n[/对话历史]`;

  return { contextText, messageCount: included.length, estimatedTokens: totalTokens };
}
