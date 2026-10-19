'use client';

import type { MediaContextAttachment } from '@cat-cafe/shared';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { ContextAttachmentView } from './ContextAttachmentView';
import { GalleryAttachmentGroup } from './content-review/GalleryAttachmentGroup';
import { sameGalleryGroup } from './content-review/media-chat-selection';
import { useChatArtworkLightbox } from './content-review/useChatArtworkLightbox';
import type { PublishedMessageCoordinate } from './content-review/usePublishedContent';
import { MarkdownContent } from './MarkdownContent';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType === 'application/zip' || mimeType === 'application/gzip' || mimeType === 'application/x-tar') return '🗜️';
  if (mimeType.startsWith('text/')) return '📝';
  if (mimeType === 'application/json') return '📋';
  return '📎';
}

function resolveUrl(url: string, isV2: boolean): string {
  if (url.startsWith('/uploads/') || (isV2 && url.startsWith('/api/workspace/file/raw?'))) return `${API_URL}${url}`;
  return url;
}

export function ContentBlocks({
  blocks,
  publication,
  fallbackText,
}: {
  blocks: MessageContent[];
  publication?: PublishedMessageCoordinate;
  /** Callback posts store their spoken body separately from attachment-only blocks. */
  fallbackText?: string;
}) {
  const published = useChatArtworkLightbox(publication);
  let fileQuoteNumber = 0;
  const renderedGalleryAttachments = new Set<string>();
  return (
    <>
      {fallbackText?.trim() && !blocks.some((block) => block.type === 'text') ? (
        <MarkdownContent content={fallbackText} />
      ) : null}
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = resolveUrl(block.url, published.isV2);
          const source = published.source(block.url, { kind: 'content-block', index: i });
          return (
            <button
              type="button"
              key={i}
              disabled={published.busy}
              aria-label={source ? '打开作品 图片' : '查看附件'}
              className="block max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe hover:opacity-90 transition-opacity"
              onClick={() =>
                void published.enlarge({
                  url: src,
                  title: '图片',
                  alt: 'attached image',
                  mediaType: 'image',
                  entry: source,
                  item: { kind: 'content-block', index: i },
                })
              }
            >
              {/* biome-ignore lint/performance/noImgElement: original uploaded dimensions are unknown at the chat entry */}
              <img src={src} alt="附件" className="max-w-full rounded-lg" />
            </button>
          );
        }
        if (block.type === 'file') {
          const src = resolveUrl(block.url, published.isV2);
          const source = published.source(block.url, { kind: 'content-block', index: i });
          if (source || (published.isV2 && block.mimeType.startsWith('video/')))
            return (
              <button
                key={i}
                type="button"
                disabled={published.busy}
                onClick={() =>
                  void published.enlarge({
                    url: src,
                    title: block.fileName,
                    alt: block.fileName,
                    mediaType: block.mimeType.startsWith('video/') ? 'video' : 'image',
                    entry: source,
                    item: { kind: 'content-block', index: i },
                  })
                }
                className="mt-2 flex max-w-sm items-center gap-2 rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-left hover:border-cafe-accent"
              >
                <span aria-hidden="true">{fileIcon(block.mimeType)}</span>
                <span className="min-w-0 truncate">{block.fileName}</span>
                <span className="shrink-0 text-xs text-cafe-muted">{source ? '打开作品' : '查看视频'}</span>
              </button>
            );
          return (
            <a
              key={i}
              href={src}
              download={block.fileName}
              className="flex items-center gap-2 bg-cafe-surface border border-cafe rounded-lg px-3 py-2 mt-2 hover:border-cafe-accent transition-colors max-w-sm"
            >
              <span className="text-2xl flex-shrink-0">{fileIcon(block.mimeType)}</span>
              <div className="flex flex-col min-w-0">
                <span className="text-sm text-cafe-secondary truncate">{block.fileName}</span>
                <span className="text-micro text-cafe-muted">
                  {block.mimeType} · {formatFileSize(block.fileSize)}
                </span>
              </div>
              <span className="ml-auto text-cafe-muted text-xs">下载</span>
            </a>
          );
        }
        if (block.type === 'context_attachment') {
          const attachment = block.attachment;
          if (attachment.kind === 'media' && attachment.gallery) {
            if (renderedGalleryAttachments.has(attachment.id)) return null;
            const group = blocks.flatMap((item) =>
              item.type === 'context_attachment' &&
              item.attachment.kind === 'media' &&
              item.attachment.gallery &&
              sameGalleryGroup(attachment.gallery!, item.attachment.gallery)
                ? [item.attachment]
                : [],
            ) satisfies MediaContextAttachment[];
            for (const member of group) renderedGalleryAttachments.add(member.id);
            return <GalleryAttachmentGroup key={attachment.id} attachments={group} />;
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
