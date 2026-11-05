import { type MessageMediaItemSelector, projectFileContent } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chatStore';
import type { ArtworkGalleryItem } from './artwork-gallery';

export type MessageArtworkItem = ArtworkGalleryItem & { readonly item: MessageMediaItemSelector };
function mediaType(name: string, url: string, mime?: string): 'image' | 'video' | null {
  const { kind } = projectFileContent({ name, url, mime });
  return kind === 'image' || kind === 'video' ? kind : null;
}

/** One visible message, in its existing content/rich-block order. No URL is authority or a publication side effect. */
export function messageArtworkItems(message: Pick<ChatMessage, 'contentBlocks' | 'extra'>): MessageArtworkItem[] {
  const result: MessageArtworkItem[] = [];
  for (const [index, block] of (message.contentBlocks ?? []).entries()) {
    if (block.type !== 'image' && block.type !== 'file') continue;
    const kind = block.type === 'image' ? 'image' : mediaType(block.fileName, block.url, block.mimeType);
    if (!kind) continue;
    const title = block.type === 'file' ? block.fileName : (block.url.split('/').at(-1) ?? '图片');
    result.push({ url: block.url, title, alt: title, mediaType: kind, item: { kind: 'content-block', index } });
  }
  for (const block of message.extra?.rich?.blocks ?? []) {
    if (block.kind === 'media_gallery' && Array.isArray(block.items)) {
      for (const [itemIndex, value] of block.items.entries()) {
        const title = value.alt ?? value.caption ?? block.title ?? value.url.split('/').at(-1) ?? '图片';
        result.push({
          url: value.url,
          title,
          alt: value.alt ?? title,
          caption: value.caption,
          mediaType: 'image',
          item: { kind: 'media-gallery', blockId: block.id, itemIndex },
        });
      }
    } else if (block.kind === 'file') {
      const kind = mediaType(block.fileName, block.url, block.mimeType);
      if (kind)
        result.push({
          url: block.url,
          title: block.fileName,
          alt: block.fileName,
          mediaType: kind,
          item: { kind: 'rich-file', blockId: block.id },
        });
    }
  }
  return result;
}
