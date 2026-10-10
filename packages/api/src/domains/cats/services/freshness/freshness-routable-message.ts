import type { StoredMessage } from '../stores/ports/MessageStore.js';

/** Content eligibility only. Does not select a delivery owner or grant a read. */
export function isFreshnessRoutableMessage(
  msg:
    | {
        userId?: string;
        origin?: string;
        content: string;
        source?: { connector?: string };
        contentBlocks?: readonly unknown[];
        extra?: {
          systemKind?: string;
          rich?: { blocks?: readonly unknown[] };
        };
      }
    | StoredMessage,
): boolean {
  if (msg.userId === 'system') return false;
  if (msg.origin === 'briefing') return false;
  if (msg.extra?.systemKind === 'context_briefing') return false;
  if (msg.source?.connector === 'routing-guard-failure') return false;
  const hasText = typeof msg.content === 'string' && msg.content.trim().length > 0;
  const hasContentBlocks = Array.isArray(msg.contentBlocks) && msg.contentBlocks.length > 0;
  const hasRichBlocks = Array.isArray(msg.extra?.rich?.blocks) && msg.extra.rich.blocks.length > 0;
  return [hasText, hasContentBlocks, hasRichBlocks].some(Boolean);
}
