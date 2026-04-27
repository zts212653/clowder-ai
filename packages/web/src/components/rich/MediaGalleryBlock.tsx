'use client';

import { useState } from 'react';
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

export function MediaGalleryBlock({ block }: { block: RichMediaGalleryBlock }) {
  const items = Array.isArray(block.items) ? block.items : [];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <>
      <div className="rounded-lg border border-cafe dark:border-gray-700 p-3">
        {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map((item, i) => {
            const src = resolveMediaUrl(item.url);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: gallery items have no stable id
              <figure key={i} className="relative group space-y-1">
                <button
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="block w-full rounded focus:outline-2 focus:outline-blue-400"
                  aria-label={`Enlarge ${item.alt ?? 'image'}`}
                >
                  {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={item.alt ?? ''}
                    className="rounded w-full object-cover max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                  />
                </button>
                <CopyButton url={src} />
                {item.caption && (
                  <figcaption className="text-xs text-cafe-secondary dark:text-gray-400">{item.caption}</figcaption>
                )}
              </figure>
            );
          })}
        </div>
      </div>
      {lightboxIndex !== null && items[lightboxIndex] && (
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
