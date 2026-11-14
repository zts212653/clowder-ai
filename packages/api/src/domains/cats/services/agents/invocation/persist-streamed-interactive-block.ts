import { isValidRichBlock } from '@cat-cafe/shared';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';

/** Persist a response-owned question before its first actionable broadcast. */
export async function persistStreamedInteractiveBlock(
  store: IMessageStore,
  event: Record<string, unknown>,
  responseMessageId: string | undefined,
): Promise<void> {
  if (!responseMessageId || event.type !== 'system_info' || typeof event.content !== 'string') return;
  if (event.messageId && event.messageId !== responseMessageId) return;
  let payload: unknown;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return; // Plain system notices have no block to publish.
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('type' in payload) ||
    payload.type !== 'rich_block' ||
    ('messageId' in payload && typeof payload.messageId === 'string') ||
    !('block' in payload) ||
    !isValidRichBlock(payload.block) ||
    payload.block.kind !== 'interactive'
  )
    return;
  const updated = await store.augmentStreamMetadata(responseMessageId, {
    extra: { rich: { v: 1, blocks: [payload.block] } },
  });
  if (!updated) throw new Error('Interactive question response could not be persisted');
}
