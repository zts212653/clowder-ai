'use client';

import { findMessageSticker, type MediaContextAttachment } from '@cat-cafe/shared';
import { StickerArtwork } from '@cat-cafe/ui';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { AuthenticatedMediaImage } from './AuthenticatedMediaImage';
import { ContextAttachmentView } from './ContextAttachmentView';
import { ContentFileAttachment } from './content-review/ContentFileAttachment';
import { GalleryAttachmentGroup } from './content-review/GalleryAttachmentGroup';
import { sameGalleryGroup } from './content-review/media-chat-selection';
import { useChatArtworkLightbox } from './content-review/useChatArtworkLightbox';
import type { PublishedMessageCoordinate } from './content-review/usePublishedContent';
import { MarkdownContent } from './MarkdownContent';

function resolveUrl(url: string, isV2: boolean): string {
  if (url.startsWith('/uploads/') || (isV2 && url.startsWith('/api/workspace/file/raw?'))) return `${API_URL}${url}`;
  return url;
}

export function ContentBlocks({
  blocks,
  publication,
  messageSource,
  fallbackText,
}: {
  blocks: MessageContent[];
  publication?: PublishedMessageCoordinate;
  /** Read-only origin of an opinion, including a queued input; never a publication grant. */
  messageSource?: Pick<PublishedMessageCoordinate, 'threadId' | 'messageId'>;
  /** Callback posts store their spoken body separately from attachment-only blocks. */
  fallbackText?: string;
}) {
  const published = useChatArtworkLightbox(publication);
  let fileQuoteNumber = 0;
  const renderedGalleryAttachments = new Set<string>();
  return (
    <>
      {fallbackText?.trim() && !blocks.some((block) => block.type === 'text') ? (
        <MarkdownContent referenceThreadId={publication?.threadId} content={fallbackText} />
      ) : null}
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} referenceThreadId={publication?.threadId} content={block.text} />;
        }
        if (block.type === 'image') {
          const source = published.source(block.url, { kind: 'content-block', index: i });
          const stickerLabel = block.sticker && findMessageSticker(block.sticker.stickerId)?.label.zh;
          const image = (
            <AuthenticatedMediaImage
              url={resolveUrl(block.url, published.isV2)}
              alt={stickerLabel || '附件'}
              key={i}
              className="block max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe hover:opacity-90 transition-opacity"
              onOpen={
                published.busy
                  ? undefined
                  : (src) => {
                      void published.enlarge({
                        url: src,
                        title: '图片',
                        alt: 'attached image',
                        mediaType: 'image',
                        entry: source,
                        item: { kind: 'content-block', index: i },
                      });
                    }
              }
            />
          );
          return stickerLabel ? <StickerArtwork key={i}>{image}</StickerArtwork> : image;
        }
        if (block.type === 'file')
          return <ContentFileAttachment key={i} block={block} publication={publication} index={i} />;
        if (block.type === 'context_attachment') {
          const attachment = block.attachment;
          if (attachment.kind === 'media') {
            if (renderedGalleryAttachments.has(attachment.id)) return null;
            const group = (
              attachment.gallery
                ? blocks.flatMap((item) =>
                    item.type === 'context_attachment' &&
                    item.attachment.kind === 'media' &&
                    item.attachment.gallery &&
                    sameGalleryGroup(attachment.gallery!, item.attachment.gallery)
                      ? [item.attachment]
                      : [],
                  )
                : [attachment]
            ) satisfies MediaContextAttachment[];
            for (const member of group) renderedGalleryAttachments.add(member.id);
            return (
              <GalleryAttachmentGroup key={attachment.id} attachments={group} message={messageSource ?? publication} />
            );
          }
          const quoteNumber =
            block.attachment.kind === 'quote' && block.attachment.source.kind === 'workspace_file'
              ? ++fileQuoteNumber
              : undefined;
          return (
            <ContextAttachmentView key={block.attachment.id} attachment={block.attachment} quoteNumber={quoteNumber} />
          );
        }
        return null;
      })}
      {published.busy ? (
        <p role="status" className="text-xs text-cafe-muted">
          正在打开作品…
        </p>
      ) : null}
      {published.error ? (
        <p role="alert" className="text-xs text-cafe-error">
          {published.error}
        </p>
      ) : null}
      {published.lightbox}
    </>
  );
}
