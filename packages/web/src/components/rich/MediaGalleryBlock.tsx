'use client';

import { useCallback, useState } from 'react';
import {
  messagePublicationSource,
  type PublishedMessageCoordinate,
  usePublishedContent,
} from '@/components/content-review/usePublishedContent';
import { CopyButton, Lightbox } from '@/components/Lightbox';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { API_URL } from '@/utils/api-client';

function resolveMediaUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith('/uploads/') ||
    trimmed.startsWith('/api/connector-media/') ||
    trimmed.startsWith('/avatars/')
  ) {
    return `${API_URL}${trimmed}`;
  }
  return trimmed;
}

export function MediaGalleryBlock({
  block,
  publication,
}: {
  block: RichMediaGalleryBlock;
  publication?: PublishedMessageCoordinate;
}) {
  const items = Array.isArray(block.items) ? block.items : [];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [failedIndices, setFailedIndices] = useState<Set<number>>(new Set());
  const published = usePublishedContent();

  const handleImgError = useCallback((index: number) => {
    setFailedIndices((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
  }, []);

  return (
    <>
      <div className="rounded-lg border border-cafe p-3">
        {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map((item, i) => {
            const src = resolveMediaUrl(item.url);
            const failed = failedIndices.has(i);
            const source = messagePublicationSource(
              publication,
              { kind: 'media-gallery', blockId: block.id, itemIndex: i },
              item.url,
            );
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: gallery items have no stable id
              <figure key={i} className="relative group space-y-1">
                {failed ? (
                  <div
                    className="rounded w-full flex flex-col items-center justify-center gap-2 bg-[var(--bg-secondary)] text-cafe-secondary px-4 py-6 min-h-[8rem]"
                    data-testid="media-gallery-error"
                  >
                    <span className="text-2xl" aria-hidden="true">
                      🖼️
                    </span>
                    <span className="text-xs font-medium">Image failed to load</span>
                    <code className="text-xs break-all max-w-full opacity-70">{item.url}</code>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={published.busy}
                    onClick={() =>
                      source
                        ? void published.open(source, item.caption ?? item.alt ?? block.title ?? '作品')
                        : setLightboxIndex(i)
                    }
                    className="block w-full rounded focus:outline-2 focus:outline-[var(--semantic-info)]"
                    aria-label={
                      source ? `打开作品 ${item.alt ?? block.title ?? '图片'}` : `Enlarge ${item.alt ?? 'image'}`
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
                    <img
                      src={src}
                      alt={item.alt ?? ''}
                      onError={() => handleImgError(i)}
                      className="rounded w-full object-cover max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                    />
                  </button>
                )}
                <CopyButton url={src} />
                {item.caption && <figcaption className="text-xs text-cafe-secondary">{item.caption}</figcaption>}
              </figure>
            );
          })}
        </div>
        {published.busy ? (
          <p role="status" className="mt-2 text-xs text-cafe-muted">
            正在打开作品…
          </p>
        ) : null}
        {published.error ? (
          <p role="alert" className="mt-2 text-xs text-cafe-error">
            {published.error}
          </p>
        ) : null}
      </div>
      {lightboxIndex !== null && items[lightboxIndex] && !failedIndices.has(lightboxIndex) && (
        <Lightbox
          url={resolveMediaUrl(items[lightboxIndex].url)}
          alt={items[lightboxIndex].alt ?? ''}
          caption={items[lightboxIndex].caption}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
