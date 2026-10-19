'use client';

import { useCallback, useState } from 'react';
import { useChatArtworkLightbox } from '@/components/content-review/useChatArtworkLightbox';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { CopyButton } from '@/components/Lightbox';
import { useShellLanguage } from '@/components/shell/shell-language';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { API_URL } from '@/utils/api-client';
import { isGalleryApiUrl, useGalleryMediaUrls } from './useGalleryMediaUrls';

function resolveMediaUrl(url: string): string {
  return isGalleryApiUrl(url) ? `${API_URL}${url}` : url;
}

export function MediaGalleryBlock({
  block,
  publication,
}: {
  block: RichMediaGalleryBlock;
  publication?: PublishedMessageCoordinate;
}) {
  const items = Array.isArray(block.items) ? block.items : [];
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const mediaUrls = useGalleryMediaUrls(items);
  const language = useShellLanguage();
  const published = useChatArtworkLightbox(publication);

  const handleImgError = useCallback((url: string) => {
    setFailedUrls((prev) => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  return (
    <>
      <div className="rounded-lg border border-cafe p-3">
        {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map((item, i) => {
            const media = mediaUrls[i];
            if (!media) return null;
            const src = media.url ? resolveMediaUrl(media.url) : '';
            const failed = !media.pending && (!src || failedUrls.has(src));
            const source = published.source(media.url ?? item.url, {
              kind: 'media-gallery',
              blockId: block.id,
              itemIndex: i,
            });
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: gallery items have no stable id
              <figure key={i} className="relative group space-y-1">
                {media.pending ? (
                  <p role="status" className="px-4 py-6 text-xs text-cafe-secondary">
                    {language === 'en' ? 'Loading image…' : '正在读取图片…'}
                  </p>
                ) : failed ? (
                  <div
                    className="rounded w-full flex flex-col items-center justify-center gap-2 bg-[var(--bg-secondary)] text-cafe-secondary px-4 py-6 min-h-[8rem]"
                    data-testid="media-gallery-error"
                  >
                    <span className="text-2xl" aria-hidden="true">
                      🖼️
                    </span>
                    <span className="text-xs font-medium">
                      {language === 'en' ? 'Image address could not be opened' : '图片地址无法打开'}
                    </span>
                    <span className="text-xs text-center">
                      {language === 'en'
                        ? 'Ask the sender to check the image address or send it again.'
                        : '请让发送者检查图片地址或重新发送。'}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={published.busy}
                    onClick={() =>
                      void published.enlarge({
                        url: src,
                        title: item.caption ?? item.alt ?? block.title ?? '图片',
                        alt: item.alt ?? '',
                        caption: item.caption,
                        mediaType: 'image',
                        entry: source,
                        item: { kind: 'media-gallery', blockId: block.id, itemIndex: i },
                      })
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
                      onError={() => handleImgError(src)}
                      className="rounded w-full object-cover max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                    />
                  </button>
                )}
                {published.isV2 ? (
                  <figcaption className="flex min-w-0 items-center gap-2 text-xs text-cafe-secondary">
                    <span className="min-w-0 flex-1 truncate" title={item.caption ?? item.alt ?? block.title}>
                      {item.caption ?? item.alt ?? block.title ?? (language === 'en' ? 'Image' : '图片')}
                    </span>
                    <span className="shrink-0 text-cafe-muted">{language === 'en' ? 'Image' : '图片'}</span>
                    {published.versionFor(source) ? (
                      <span className="shrink-0">v{published.versionFor(source)}</span>
                    ) : null}
                    {!media.pending && !failed ? (
                      <button
                        type="button"
                        disabled={published.busy}
                        className="shrink-0 rounded border border-cafe-subtle px-2 py-1 font-semibold text-cafe-accent"
                        onClick={() =>
                          void published.openWorkMode({
                            url: src,
                            title: item.caption ?? item.alt ?? block.title ?? '图片',
                            alt: item.alt ?? '',
                            caption: item.caption,
                            mediaType: 'image',
                            entry: source,
                            item: { kind: 'media-gallery', blockId: block.id, itemIndex: i },
                          })
                        }
                      >
                        {language === 'en' ? 'Open' : '打开'}
                      </button>
                    ) : null}
                  </figcaption>
                ) : item.caption ? (
                  <figcaption className="text-xs text-cafe-secondary">{item.caption}</figcaption>
                ) : null}
                {src && <CopyButton url={src} placement={published.isV2 ? 'below' : 'overlay'} />}
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
      {published.lightbox}
    </>
  );
}
