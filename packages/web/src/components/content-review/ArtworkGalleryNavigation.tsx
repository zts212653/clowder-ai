'use client';

import { type RefObject, useEffect, useRef } from 'react';
import { useShellLanguage } from '@/components/shell/shell-language';
import { type ArtworkGallery, galleryNavigationBlocked } from './artwork-gallery';
import styles from './artwork-gallery.module.css';

export function useArtworkGalleryNavigation(gallery: ArtworkGallery | undefined, root: RefObject<HTMLElement>) {
  const current = useRef(gallery);
  current.current = gallery;
  const enabled = !!gallery && gallery.items.length > 1;
  useEffect(() => {
    if (!enabled) return;
    const move = (step: number) => {
      const value = current.current;
      if (!value || value.busy) return;
      const index = value.index + step;
      if (index >= 0 && index < value.items.length) value.onSelect(index);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (document.fullscreenElement) return;
      if (
        !root.current ||
        root.current.closest('[hidden], [inert], [aria-hidden="true"]') ||
        galleryNavigationBlocked(event) ||
        document.querySelector('[role="menu"]')
      )
        return;
      // Another mounted/hidden work viewer must not consume this reader's keyboard.
      if (
        document.activeElement &&
        document.activeElement !== document.body &&
        !root.current.contains(document.activeElement)
      )
        return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    };
    let distance = 0,
      lastEvent = 0,
      lastMove = 0;
    const wheel = (event: WheelEvent) => {
      if (galleryNavigationBlocked(event) || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const now = Date.now();
      if (now - lastEvent > 180) distance = 0;
      distance += event.deltaX;
      lastEvent = now;
      event.preventDefault();
      if (Math.abs(distance) >= 48 && now - lastMove > 350) {
        move(distance > 0 ? 1 : -1);
        distance = 0;
        lastMove = now;
      }
    };
    const element = root.current;
    document.addEventListener('keydown', keyboard);
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      document.removeEventListener('keydown', keyboard);
      element?.removeEventListener('wheel', wheel);
    };
  }, [enabled, root]);
}

export function ArtworkGalleryArrows({ gallery }: { gallery: ArtworkGallery }) {
  const english = useShellLanguage() === 'en';
  if (gallery.items.length < 2) return null;
  return (
    <>
      <button
        type="button"
        className={`${styles.arrow} ${styles.previous}`}
        aria-label={english ? 'Previous artwork' : '上一件作品'}
        disabled={gallery.busy || gallery.index === 0}
        onClick={() => gallery.onSelect(gallery.index - 1)}
      >
        ‹
      </button>
      <button
        type="button"
        className={`${styles.arrow} ${styles.next}`}
        aria-label={english ? 'Next artwork' : '下一件作品'}
        disabled={gallery.busy || gallery.index === gallery.items.length - 1}
        onClick={() => gallery.onSelect(gallery.index + 1)}
      >
        ›
      </button>
    </>
  );
}

export function ArtworkGalleryNavigation({ gallery, arrows = true }: { gallery: ArtworkGallery; arrows?: boolean }) {
  const english = useShellLanguage() === 'en';
  if (gallery.items.length < 2) return null;
  return (
    <>
      {arrows ? <ArtworkGalleryArrows gallery={gallery} /> : null}
      <nav
        className={styles.thumbnails}
        aria-label={english ? 'Artworks in this message' : '这条消息中的作品'}
        data-testid="artwork-gallery-thumbnails"
      >
        {gallery.items.map((item, index) => (
          <button
            key={item.origin ? JSON.stringify(item.origin.item) : item.url + index}
            type="button"
            disabled={gallery.busy}
            aria-label={english ? `Artwork ${index + 1}: ${item.title}` : `图 ${index + 1}：${item.title}`}
            aria-current={index === gallery.index ? 'true' : undefined}
            onClick={() => gallery.onSelect(index)}
          >
            {item.mediaType === 'image' && item.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.url} alt="" loading="lazy" />
            ) : (
              <span aria-hidden="true">▶</span>
            )}
            <span className={styles.ordinal}>{index + 1}</span>
            {gallery.selectionCounts?.[index] ? (
              <span className={styles.badge}>{gallery.selectionCounts[index]}</span>
            ) : null}
          </button>
        ))}
      </nav>
    </>
  );
}
