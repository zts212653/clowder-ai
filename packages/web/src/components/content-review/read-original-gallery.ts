import { type MediaGalleryOrigin, messageMediaItemKey } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { messageArtworkItems } from './message-artwork-gallery';
import { checked } from './modification-http';

/** Rehydrate only the named visible message, including after refresh. An adjacent message is never a substitute. */
export async function readOriginalGallery(origin: MediaGalleryOrigin) {
  const timestamp = Number(origin.messageRevision);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('原消息版本无法核对。');
  const params = new URLSearchParams({ threadId: origin.threadId, before: String(timestamp + 1), limit: '100' });
  const result = await checked<{ messages: ChatMessage[] }>(await apiFetch(`/api/messages?${params}`));
  const message = result.messages?.find((item) => item.id === origin.messageId);
  if (!message || String(message.timestamp) !== origin.messageRevision || message.extra?.recall)
    throw new Error('原消息已变化或不可读取，草稿中的原件引用仍然保留。');
  const items = messageArtworkItems(message);
  if (
    items.length !== origin.count ||
    !items[origin.index] ||
    messageMediaItemKey(items[origin.index].item) !== messageMediaItemKey(origin.item)
  )
    throw new Error('原图组位置无法核对，未猜测其它图片。');
  return items;
}
