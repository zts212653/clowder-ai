import { fileContentKind } from '@cat-cafe/shared';
import { type ReactNode, type RefObject, useLayoutEffect } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import styles from './artwork-actions.module.css';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import { artworkApplicationName, artworkFileDate, fileByteLengthLabel } from './artwork-file-labels';
import { type ContentFileInfo, fileDownloadUrl } from './file-action-client';
import { contentApiBase } from './file-source';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
/** Keep keyboard focus on visible actions when narrow-only actions are disclosed. */
export function fileMenuItems(menu: HTMLDivElement | null) {
  return Array.from(menu?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') ?? []).filter(
    (node) => getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden',
  );
}
export function FileActionMenu({
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
  canCopyContent,
  copyContent,
  copyName,
}: {
  position: { x: number; y: number };
  menu: RefObject<HTMLDivElement>;
  trigger: RefObject<HTMLButtonElement>;
  info: ContentFileInfo | null;
  link: string;
  filename: string;
  mime?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  isVideo: boolean;
  src: string | null;
  wholeWorkAction?: ReactNode;
  history?: (() => void) | null;
  scale?: number;
  close: () => void;
  copyLocation: () => void;
  copyPixels: () => void;
  fileAction: (action: 'reveal' | 'open') => void;
  toggleSize?: () => void;
  download: () => void;
  workMode?: { run: () => void; busy: boolean } | null;
  canCopyContent?: boolean;
  copyContent?: () => void;
  copyName?: () => void;
}) {
  useLayoutEffect(() => {
    // The browser top layer escapes clipped/card containing blocks while the
    // menu stays in its owner's DOM focus scope (including a floating dialog).
    menu.current?.showPopover?.();
  }, [menu]);
  const t = useShellCopy(artworkActionsCopy);
  const language = useShellLanguage();
  const directory = info?.mime === 'inode/directory';
  const nativeMedia = ['image', 'video', 'audio'].includes(fileContentKind(filename, info?.mime ?? mime));
  const nativeLink = nativeMedia ? link : fileDownloadUrl(link);
  const date = artworkFileDate(info?.createdAt ?? info?.modifiedAt, language);
  const location = info === null ? t.loading : info.local ? (info.displayPath ?? info.path) : link;
  const bytes = info?.byteLength ?? byteLength;
  const fileSize = fileByteLengthLabel(bytes);
  return (
    <div
      ref={menu}
      className={styles.menu}
      role="menu"
      popover="manual"
      aria-label={t.more}
      style={{ position: 'fixed', left: position.x, top: position.y }}
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
          const items = fileMenuItems(menu.current);
          const index = items.indexOf(document.activeElement as HTMLElement);
          items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <div className={styles.group}>
        {info?.local ? (
          <>
            {info.canReveal !== false && (
              <button role="menuitem" type="button" onClick={() => fileAction('reveal')}>
                <ReviewToolbarIcon name="folder" />
                {t.reveal}
              </button>
            )}
            {info.canOpen !== false && (
              <button role="menuitem" type="button" onClick={() => fileAction('open')}>
                <ReviewToolbarIcon name="external" />
                {t.open}
                <small>
                  {artworkApplicationName(info.defaultApplication, info.defaultApplicationBundleId, t.preview)}
                </small>
              </button>
            )}
          </>
        ) : null}
        <button role="menuitem" type="button" disabled={info === null} onClick={copyLocation}>
          <ReviewToolbarIcon name="copy" />
          {info === null ? t.loading : info.local ? t.copyPath : t.copyLink}
        </button>
        {src && !directory ? (
          <button role="menuitem" type="button" disabled={!src} onClick={copyPixels}>
            <ReviewToolbarIcon name={isVideo ? 'video' : 'image'} />
            {isVideo ? t.copyFrame : t.copyImage}
            <small>⌘C</small>
          </button>
        ) : null}
        {canCopyContent && !directory && (
          <button role="menuitem" type="button" onClick={copyContent}>
            {t.copyContent}
          </button>
        )}
        {!directory && (
          <a
            role="menuitem"
            href={nativeLink ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => close()}
          >
            <ReviewToolbarIcon name="external" />
            {t.newTab}
          </a>
        )}
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
        {!directory && (
          <a
            role="menuitem"
            href={nativeLink ?? undefined}
            download={filename}
            onClick={(event) => {
              const api = contentApiBase();
              if (new URL(link).origin !== api.origin) {
                close();
                return;
              }
              event.preventDefault();
              close();
              download();
            }}
          >
            <ReviewToolbarIcon name="download" />
            {t.download}
          </a>
        )}
        {/* The child owns the click before this bubble handler dismisses its menu. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: delegates dismissal after the nested accessible button executes. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activates the nested button's click. */}
        <div className={styles.wholeWork} onClick={close}>
          {wholeWorkAction}
        </div>
        {history ? (
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              close();
              history?.();
            }}
          >
            <ReviewToolbarIcon name="history" />
            {t.history}
          </button>
        ) : null}
        {toggleSize ? (
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
            <small>{Math.round((scale ?? 1) * 100)}%</small>
          </button>
        ) : null}
      </div>
      <section className={styles.info} aria-label={t.fileInfo}>
        <strong>{filename}</strong>
        {copyName && (
          <button type="button" onClick={copyName}>
            {t.copyFilename}
          </button>
        )}
        <p>
          {width && height ? `${width} × ${height} · ` : ''}
          {(info?.mime ?? mime)?.split('/')[1]?.toUpperCase()}
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
