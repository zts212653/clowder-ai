import { projectMarkdownReadableText, type ResolvedMessageSelectionItem } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

/** Per-capture resolved items are injected before navigation; they never enter persisted chat state. */
declare global {
  interface Window {
    __catCafeImageExportItems?: readonly ResolvedMessageSelectionItem[];
  }
}

export function projectMessagePartsForImage(
  message: ChatMessage,
  items: readonly ResolvedMessageSelectionItem[],
): ChatMessage {
  const parts = items.filter((item) => item.messageId === message.id);
  if (parts.some((item) => item.kind === 'message')) return message;
  const quotes = parts.filter((item) => item.kind === 'quote' || item.kind === 'cli_quote');
  const text = quotes.map((item) => item.readableContent).join('\n\n');
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  // Preserve the original Markdown when the body was selected in full; arbitrary quotes remain literal text.
  const content =
    text && normalize(text) === normalize(projectMarkdownReadableText(message.content))
      ? message.content
      : text.replace(/[\\`*_{}[\]<>#+.!|~-]/g, '\\$&');
  const blocks = parts.flatMap((item) => (item.kind === 'rich_block' && item.richBlock ? [item.richBlock] : []));
  return {
    ...message,
    content,
    contentBlocks: [],
    toolEvents: [],
    thinking: undefined,
    extra: { ...message.extra, stream: undefined, rich: { v: 1, blocks } },
  };
}
