'use client';

import { useState } from 'react';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { ContextAttachmentView } from './ContextAttachmentView';
import { Lightbox } from './Lightbox';
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

function resolveUrl(url: string): string {
  if (url.startsWith('/uploads/')) return `${API_URL}${url}`;
  return url;
}

export function ContentBlocks({ blocks }: { blocks: MessageContent[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = resolveUrl(block.url);
          return (
            // biome-ignore lint/performance/noImgElement: uploaded images cannot use next/image
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt="attached image"
              className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(src)}
            />
          );
        }
        if (block.type === 'file') {
          const src = resolveUrl(block.url);
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
          return <ContextAttachmentView key={block.attachment.id} attachment={block.attachment} />;
        }
        return null;
      })}
      {lightboxSrc && <Lightbox url={lightboxSrc} alt="attached image" onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
