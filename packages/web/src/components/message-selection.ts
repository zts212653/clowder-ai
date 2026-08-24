import { isSelectableManagedHoldConnectorSource } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chatStore';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';

export const MAX_SELECTED_MESSAGES = 50;

/**
 * Client-side affordance filter. The server resolver remains authoritative and
 * repeats thread ownership, publication, visibility, and source validation.
 */
export function isMessageSelectableForBundle(message: ChatMessage): boolean {
  const authoredMessage = message.type === 'user' || message.type === 'assistant';
  const managedHoldConnector =
    message.type === 'connector' &&
    isSelectableManagedHoldConnectorSource(message.source) &&
    message.extra?.queueReceipt !== undefined &&
    message.extra.scheduler?.hiddenTrigger !== true;
  if (!authoredMessage && !managedHoldConnector) return false;
  if (message.isStreaming || message.extra?.recall || (!managedHoldConnector && message.extra?.scheduler)) return false;

  return Boolean(message.content.trim() || message.contentBlocks?.length || message.extra?.rich?.blocks.length);
}

/** Derive request order from canonical timeline facts, never selection click order. */
export function normalizeSelectedMessageIds(
  messages: readonly ChatMessage[],
  selectedIds: ReadonlySet<string>,
): string[] {
  return messages
    .filter((message) => selectedIds.has(message.id) && isMessageSelectableForBundle(message))
    .sort((left, right) => {
      const delta = getMessageTimelineOrderTime(left) - getMessageTimelineOrderTime(right);
      return delta || left.id.localeCompare(right.id);
    })
    .map((message) => message.id);
}
