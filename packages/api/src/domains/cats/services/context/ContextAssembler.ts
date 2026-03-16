/**
 * Context Assembler
 * 从 messageStore 历史消息组装上下文字符串，prepend 到猫的 prompt 中。
 * 解决跨猫历史不可见问题 (猫咖狼人杀 bug report 的核心修复)。
 *
 * formatMessage() 也被 export route 复用 (聊天记录导出)。
 */

import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../utils/token-counter.js';
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

/**
 * Get display name for a message sender.
 * catId === null → user ("铲屎官"), otherwise look up CAT_CONFIGS.
 * For variant cats (e.g. sonnet, opus-45), includes variantLabel to distinguish same-family members.
 */
function getSenderName(catId: string | null): string {
  if (catId === null) return '铲屎官';
  const entry = catRegistry.tryGet(catId);
  const config = entry?.config ?? CAT_CONFIGS[catId];
  if (!config) return catId;
  const variantLabel = config.variantLabel?.trim();
  if (!variantLabel) return config.displayName;
  if (config.displayName.toLowerCase().includes(variantLabel.toLowerCase())) {
    return config.displayName;
  }
  return `${config.displayName}(${variantLabel})`;
}

/** Format timestamp as HH:MM */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
export function formatMessage(msg: StoredMessage, options?: { truncate?: number }): string {
  const time = formatTime(msg.timestamp);
  const sender = msg.source ? msg.source.label : getSenderName(msg.catId);
  // F52: Annotate cross-thread messages with source thread
  const crossPostTag = msg.extra?.crossPost?.sourceThreadId
    ? ` ← from thread:${msg.extra.crossPost.sourceThreadId.slice(0, 8)}`
    : '';
  let content = msg.content;
  if (options?.truncate && content.length > options.truncate) {
    content = truncateHeadTail(content, options.truncate);
  }
  return `[${time} ${sender}${crossPostTag}] ${content}`;
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
  const deliveredMessages = messages.filter(isDelivered);

  if (deliveredMessages.length === 0) {
    return { contextText: '', messageCount: 0, estimatedTokens: 0 };
  }

  // Take the most recent N messages (messages are already chronological from store)
  const recent = deliveredMessages.length > maxMessages ? deliveredMessages.slice(-maxMessages) : deliveredMessages;

  // Format all messages, then apply token budget from most-recent backward
  const formatted = recent.map((m) => formatMessage(m, { truncate: maxContentLength }));

  // Estimate overhead for header + separator
  const overheadTokens = estimateTokens('[对话历史 - 最近 99 条]\n[/对话历史]');

  let totalTokens = overheadTokens;
  let startIndex = formatted.length; // will walk backward
  for (let i = formatted.length - 1; i >= 0; i--) {
    const lineTokens = estimateTokens(`${formatted[i]!}\n`);
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
