import type { ReactNode, RefObject } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import styles from './artwork-actions.module.css';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import type { ArtworkFileInfo } from './artwork-file-client';
import { artworkApplicationName, artworkFileDate } from './artwork-file-labels';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
/** Keep keyboard focus on visible actions when narrow-only actions are disclosed. */
export function artworkMenuItems(menu: HTMLDivElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? []).filter(
    (node) => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden',
  );
}
export function ArtworkActionMenu({
  position,
  menu,
  trigger,
  info,
  link,
  filename,
  mime,
  byteLength,
  width,
  height,
  isVideo,
  src,
  wholeWorkAction,
  history,
  scale,
  close,
  copyLocation,
  copyPixels,
  fileAction,
  toggleSize,
  download,
  workMode,
}: {
  position: { x: number; y: number };
  menu: RefObject<HTMLDivElement>;
  trigger: RefObject<HTMLButtonElement>;
  info: ArtworkFileInfo | null;
  link: string;
  filename: string;
  mime?: string;
  byteLength?: number;
  width: number;
  height: number;
  isVideo: boolean;
  src: string | null;
  wholeWorkAction?: ReactNode;
  history?: (() => void) | null;
  scale: number;
  close: () => void;
  copyLocation: () => void;
  copyPixels: () => void;
  fileAction: (action: 'reveal' | 'open') => void;
  toggleSize: () => void;
  download: () => void;
  workMode?: { run: () => void; busy: boolean } | null;
}) {
  const t = useShellCopy(artworkActionsCopy);
  const language = useShellLanguage();
  const date = artworkFileDate(info?.createdAt ?? info?.modifiedAt, language);
  const location = info === null ? t.loading : info.local ? (info.displayPath ?? info.path) : link;
  const bytes = info?.byteLength ?? byteLength;
  const fileSize =
    bytes === undefined
      ? null
      : bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      aria-label={t.more}
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = artworkMenuItems(menu.current);
          const index = items.indexOf(document.activeElement as HTMLElement);
          items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <div className={styles.group}>
        {info?.local ? (
          <>
            <button role="menuitem" type="button" onClick={() => fileAction('reveal')}>
              <ReviewToolbarIcon name="folder" />
              {t.reveal}
            </button>
            <button role="menuitem" type="button" onClick={() => fileAction('open')}>
              <ReviewToolbarIcon name="external" />
              {t.open}
              <small>
                {artworkApplicationName(info.defaultApplication, info.defaultApplicationBundleId, t.preview)}
              </small>
            </button>
          </>
        ) : null}
        <button role="menuitem" type="button" disabled={info === null} onClick={copyLocation}>
          <ReviewToolbarIcon name="copy" />
          {info === null ? t.loading : info.local ? t.copyPath : t.copyLink}
        </button>
        <button role="menuitem" type="button" disabled={!src} onClick={copyPixels}>
          <ReviewToolbarIcon name={isVideo ? 'video' : 'image'} />
          {isVideo ? t.copyFrame : t.copyImage}
          <small>⌘C</small>
        </button>
        <a role="menuitem" href={link} target="_blank" rel="noopener noreferrer" onClick={() => close()}>
          <ReviewToolbarIcon name="external" />
          {t.newTab}
        </a>
      </div>
      <div className={styles.group}>
        {workMode ? (
          <button
            role="menuitem"
            type="button"
            className={styles.narrowMenuAction}
            disabled={workMode.busy}
            onClick={() => {
              close();
              workMode.run();
            }}
          >
            <ReviewToolbarIcon name="external" />
            {t.workMode}
          </button>
        ) : null}
        <button
          role="menuitem"
          type="button"
          className={styles.narrowMenuAction}
          onClick={() => {
            close();
            download();
          }}
        >
          <ReviewToolbarIcon name="download" />
          {t.download}
        </button>
        {/* The child owns the click before this bubble handler dismisses its menu. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates dismissal after the nested accessible button executes. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activates the nested button's click. */}
        <div className={styles.wholeWork} onClick={close}>
          {wholeWorkAction}
        </div>
        <button
          role="menuitem"
          type="button"
          disabled={!history}
          onClick={() => {
            close();
            history?.();
          }}
        >
          <ReviewToolbarIcon name="history" />
          {t.history}
        </button>
        <button
          role="menuitem"
          type="button"
          onClick={() => {
            toggleSize();
            close();
          }}
        >
          <ReviewToolbarIcon name="resize" />
          {t.actual} / {t.fit}
          <small>{Math.round(scale * 100)}%</small>
        </button>
      </div>
      <section className={styles.info} aria-label={t.fileInfo}>
        <strong>{filename}</strong>
        <p>
          {width} × {height} · {mime?.split('/')[1]?.toUpperCase()}
          {fileSize ? ` · ${fileSize}` : ''}
          {` · ${info?.author ?? t.unknownAuthor}`}
          {date ? ` · ${date}` : ''}
        </p>
        <button type="button" className={styles.path} disabled={info === null} onClick={copyLocation}>
          {location}
        </button>
      </section>
    </div>
  );
}
