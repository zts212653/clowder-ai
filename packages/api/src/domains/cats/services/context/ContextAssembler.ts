/**
 * Context Assembler
 * 从 messageStore 历史消息组装上下文字符串，prepend 到猫的 prompt 中。
 * 解决跨猫历史不可见问题 (猫咖狼人杀 bug report 的核心修复)。
 *
 * formatMessage() 也被 export route 复用 (聊天记录导出)。
 */

import { catRegistry } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../utils/token-counter.js';
import { formatPromptTime } from '../format-time.js';
import { isDelivered, type StoredMessage } from '../stores/ports/MessageStore.js';

export interface ContextAssemblerOptions {
  /** Maximum number of recent messages to include (default: 20) */
  maxMessages?: number;
  /** Maximum characters per message content (default: 1500) */
  maxContentLength?: number;
  /** Maximum total tokens for assembled context (default: 2000) */
  maxTotalTokens?: number;
  /** @deprecated Use maxTotalTokens instead. Kept for backward compat during migration. */
  maxTotalChars?: number;
}

export interface AssembledContext {
  /** Formatted context string to prepend to prompt */
  contextText: string;
  /** Number of messages included */
  messageCount: number;
  /** Estimated token count of contextText (F8: for budget tracking) */
  estimatedTokens: number;
}

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_CONTENT_LENGTH = 1500;
const DEFAULT_MAX_TOTAL_TOKENS = 2000;
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
 * @returns `[HH:MM 角色名] 内容`
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
  const sender = msg.source ? msg.source.label : getSenderName(msg.catId);
  // F52: Annotate cross-thread messages with source thread
  const crossPostTag = msg.extra?.crossPost?.sourceThreadId
    ? ` ← from thread:${msg.extra.crossPost.sourceThreadId.slice(0, 8)}`
    : '';

  // #699: Inline reply-to preview — saves agents a get_message tool call.
  // Only resolves when messageMap is provided and the parent is in scope.
  let replyPrefix = '';
  if (msg.replyTo && options?.messageMap) {
    const parent = options.messageMap.get(msg.replyTo);
    if (parent) {
      const parentSender = parent.source ? parent.source.label : getSenderName(parent.catId);
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
  const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxContentLength =
    options?.maxContentLength ?? (Number(process.env.MAX_CONTEXT_MSG_CHARS) || DEFAULT_MAX_CONTENT_LENGTH);
  // F8: token-based budget (maxTotalTokens preferred, maxTotalChars fallback for compat)
  const maxTotalTokens = options?.maxTotalTokens ?? options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_TOKENS;

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

  // Take the most recent N messages (messages are already chronological from store)
  const recent = deliveredMessages.length > maxMessages ? deliveredMessages.slice(-maxMessages) : deliveredMessages;

  // #699: Build message map for inline reply-to preview resolution.
  // Use deliveredMessages (not raw input) so system/undelivered/error parents
  // can't leak into prompt via formatMessage's inline preview.
  const messageMap = buildMessageMap(deliveredMessages);

  // Format all messages, then apply token budget from most-recent backward
  const formatted = recent.map((m) => formatMessage(m, { truncate: maxContentLength, messageMap }));

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
