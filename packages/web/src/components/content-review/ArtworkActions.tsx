'use client';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { ArtworkActionMenu, artworkMenuItems } from './ArtworkActionMenu';
import { useArtworkChrome } from './ArtworkChrome';
import styles from './artwork-actions.module.css';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import {
  type ArtworkFileInfo,
  artworkFileInfo,
  copyArtworkPixels,
  downloadArtworkFile,
  runArtworkFileAction,
} from './artwork-file-client';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import type { useArtworkViewport } from './useArtworkViewport';

type ArtworkNotice = 'failed' | 'copiedFrame' | 'copiedImage' | 'copiedPath' | 'copiedLink';

export function ArtworkActions({
  src,
  mediaType,
  originalUrl,
  filename,
  mime,
  byteLength,
  width,
  height,
  root,
  viewport,
  wholeWorkAction,
  onHistory,
}: {
  src: string | null;
  mediaType?: 'image' | 'video';
  originalUrl: string;
  filename: string;
  mime?: string;
  byteLength?: number;
  width: number;
  height: number;
  root: RefObject<HTMLElement>;
  viewport: Pick<ReturnType<typeof useArtworkViewport>, 'renderedScale' | 'fit' | 'actual'>;
  wholeWorkAction?: ReactNode;
  onHistory?: () => void;
}) {
  const chrome = useArtworkChrome();
  const t = useShellCopy(artworkActionsCopy);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [info, setInfo] = useState<ArtworkFileInfo | null>(null);
  const [notice, setNotice] = useState<ArtworkNotice | null>(null);
  const menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const initialFocus = useRef<HTMLElement | null>(null);
  const isVideo = mediaType === 'video' || !!mime?.startsWith('video/');
  const link = new URL(originalUrl, API_URL).href;
  const feedback = (message: ArtworkNotice) => {
    clearTimeout(timer.current);
    setNotice(message);
    timer.current = setTimeout(() => setNotice(null), 1800);
  };
  useEffect(() => {
    generation.current++;
    setPosition(null);
    setInfo(null);
    return () => {
      generation.current++;
      clearTimeout(timer.current);
    };
  }, [originalUrl]);
  const perform = async (action: () => Promise<void>, message?: ArtworkNotice) => {
    const scope = generation.current;
    setPosition(null);
    try {
      await action();
      if (scope === generation.current && message) feedback(message);
    } catch {
      if (scope === generation.current) feedback('failed');
    }
  };
  const copyPixels = () =>
    perform(
      async () => {
        const element = root.current?.querySelector('img,video');
        if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement) || !src)
          throw new Error('media_unavailable');
        await copyArtworkPixels(element, src);
      },
      isVideo ? 'copiedFrame' : 'copiedImage',
    );
  const copyLocation = () =>
    perform(
      () => navigator.clipboard.writeText(info?.local && info.path ? info.path : link),
      info?.local ? 'copiedPath' : 'copiedLink',
    );
  const openMenu = (x: number, y: number) => {
    initialFocus.current = null;
    setInfo(null);
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - 308)),
      y: Math.max(8, Math.min(y, window.innerHeight - 550)),
    });
    const scope = generation.current;
    void artworkFileInfo(originalUrl)
      .then((value) => {
        if (scope === generation.current) setInfo(value);
      })
      .catch(() => {
        if (scope === generation.current) {
          setInfo({ local: false });
          feedback('failed');
        }
      });
  };
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const context = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.clientX, event.clientY);
    };
    const copy = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLowerCase() !== 'c' ||
        event.altKey ||
        event.shiftKey ||
        (target instanceof Element && target.closest('input,textarea,[contenteditable="true"]')) ||
        window.getSelection()?.toString() ||
        !element.getClientRects().length ||
        element.closest('[hidden], [aria-hidden="true"]')
      )
        return;
      const owner =
        element.closest('[role="dialog"]') ?? element.closest('[data-testid="workspace-content-review-surface"]');
      if (!owner?.contains(document.activeElement)) return;
      event.preventDefault();
      void copyPixels();
    };
    element.addEventListener('contextmenu', context);
    document.addEventListener('keydown', copy);
    return () => {
      element.removeEventListener('contextmenu', context);
      document.removeEventListener('keydown', copy);
    };
  });
  useEffect(() => {
    if (!position) return;
    // A delayed local file-info inserts Finder before the temporary first enabled item.
    // Keep the default at the first item, but never steal focus after the reader navigated.
    const first = artworkMenuItems(menu.current)[0];
    if (first && (!initialFocus.current || document.activeElement === initialFocus.current)) {
      first.focus();
      initialFocus.current = first;
    }
  }, [position, info]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setPosition(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [position]);
  if (!chrome?.actions) return null;
  return createPortal(
    <>
      <button
        type="button"
        onClick={() => void perform(() => downloadArtworkFile(originalUrl, filename))}
        className={`${styles.trigger} ${styles.download}`}
        aria-label={t.download}
        title={t.download}
      >
        <span className={styles.downloadIcon}>
          <ReviewToolbarIcon name="download" />
        </span>
        <span className={styles.downloadLabel}>{t.download}</span>
      </button>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={t.more}
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => {
          if (position) setPosition(null);
          else {
            const r = trigger.current?.getBoundingClientRect();
            openMenu(r?.right ?? 8, r?.bottom ?? 8);
          }
        }}
      >
        ⋯
      </button>
      {position ? (
        <ArtworkActionMenu
          position={position}
          menu={menu}
          trigger={trigger}
          info={info}
          link={link}
          filename={filename}
          mime={mime}
          byteLength={byteLength}
          width={width}
          height={height}
          isVideo={isVideo}
          src={src}
          wholeWorkAction={wholeWorkAction}
          workMode={chrome.workMode}
          download={() => void perform(() => downloadArtworkFile(link, filename))}
          history={onHistory ?? chrome.history}
          scale={viewport.renderedScale}
          close={() => setPosition(null)}
          copyLocation={copyLocation}
          copyPixels={copyPixels}
          fileAction={(action) => void perform(() => runArtworkFileAction(originalUrl, action))}
          toggleSize={() => {
            if (Math.abs(viewport.renderedScale - 1) < 0.001) viewport.fit();
            else viewport.actual();
          }}
        />
      ) : null}
      {notice ? <output className={styles.notice}>{t[notice]}</output> : null}
    </>,
    chrome.actions,
  );
}
