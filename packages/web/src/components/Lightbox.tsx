'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArtworkChromeProvider } from './content-review/ArtworkChrome';
import { ArtworkFloatingHeader } from './content-review/ArtworkFloatingHeader';
import { ArtworkGalleryNavigation, useArtworkGalleryNavigation } from './content-review/ArtworkGalleryNavigation';
import { ArtworkPreviewMedia } from './content-review/ArtworkPreviewMedia';
import type { ArtworkGallery } from './content-review/artwork-gallery';
import artworkStyles from './content-review/artwork-lightbox.module.css';
import { ContentMediaElement } from './content-review/ContentMediaElement';
import { FileActions } from './content-review/FileActions';
import { lightboxCopy } from './lightbox.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellPresentation } from './shell/shell-presentation';

/** Legacy placement only; copy/feedback and source handling belong to FileActions. */
export function CopyButton({ url, placement = 'overlay' }: { url: string; placement?: 'overlay' | 'below' }) {
  return (
    <span className={placement === 'overlay' ? 'absolute right-2 top-2' : ''}>
      <FileActions source={{ kind: 'url', url }} src={url} mediaType="image" filename="image.png" appearance="copy" />
    </span>
  );
}

export function Lightbox({
  url,
  alt,
  caption,
  annotationUnavailableReason,
  mediaType = 'image',
  onOpenWorkspace,
  workspaceBusy,
  workspaceError,
  children,
  composerSlot,
  gallery,
  onClose,
}: {
  url: string;
  alt: string;
  caption?: string;
  annotationUnavailableReason?: string;
  mediaType?: 'image' | 'video';
  onOpenWorkspace?: () => Promise<boolean>;
  workspaceBusy?: boolean;
  workspaceError?: string | null;
  children?: ReactNode;
  composerSlot?: ReactNode;
  gallery?: ArtworkGallery;
  onClose: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(lightboxCopy);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useArtworkGalleryNavigation(gallery, dialog);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const handleKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.fullscreenElement) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const available = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ].filter((node) => node.getClientRects().length && !node.closest('[hidden], [inert]'));
        const first = available[0],
          last = available.at(-1);
        if (first && last && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus({ preventScroll: true });
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled via useEffect
    <ArtworkChromeProvider>
      <div
        role="dialog"
        ref={dialog}
        aria-modal="true"
        aria-label={alt || (isV2 ? (mediaType === 'image' ? t.imagePreview : t.videoPreview) : 'Image preview')}
        className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-heavy)] backdrop-blur-sm"
        style={composerSlot ? { background: 'rgba(0,0,0,0.90)' } : undefined}
        onClick={onClose}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only, not interactive */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: container prevents backdrop close */}
        <div
          className={
            composerSlot
              ? `group ${artworkStyles.window}`
              : 'relative group max-w-[90vw] max-h-[90vh] flex flex-col items-center'
          }
          onClick={(e) => e.stopPropagation()}
        >
          {composerSlot ? (
            <ArtworkFloatingHeader
              title={alt}
              position={
                gallery && gallery.items.length > 1 ? `${gallery.index + 1} / ${gallery.items.length}` : undefined
              }
              onClose={onClose}
              closeRef={closeButton}
              onOpenWorkspace={onOpenWorkspace}
              busy={workspaceBusy}
              onError={setOpenError}
            />
          ) : (
            <>
              <button
                ref={closeButton}
                type="button"
                onClick={onClose}
                className="absolute -top-3 -right-3 bg-[var(--console-overlay-heavy)] hover:bg-[var(--console-overlay-heavy-hover)] text-[var(--overlay-fg)] rounded-full w-8 h-8 flex items-center justify-center text-lg z-10"
                title={isV2 ? t.close : 'Close'}
              >
                &times;
              </button>
              {onOpenWorkspace ? (
                <button
                  type="button"
                  data-testid="lightbox-open-workspace"
                  disabled={workspaceBusy || opening}
                  onClick={async () => {
                    setOpening(true);
                    setOpenError(null);
                    try {
                      if (await onOpenWorkspace()) onClose();
                      else setOpenError('未能进入作品模式，请确认原作品仍可访问后重试。');
                    } catch {
                      setOpenError('暂时无法打开作品模式，请重试。');
                    } finally {
                      setOpening(false);
                    }
                  }}
                  className="absolute -top-8 right-10 z-10 rounded-md bg-[var(--console-overlay-control)] px-3 py-2 text-sm text-[var(--overlay-fg)]"
                >
                  作品模式
                </button>
              ) : null}
            </>
          )}
          {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {children ??
            (composerSlot ? (
              <ArtworkPreviewMedia url={url} title={alt} video={mediaType === 'video'} gallery={gallery} />
            ) : mediaType === 'video' ? (
              <ContentMediaElement
                kind="video"
                src={url}
                title={alt}
                videoProps={{ controls: true, preload: 'metadata', 'aria-label': alt }}
                className="max-w-full max-h-[85vh] rounded-lg"
              />
            ) : (
              <ContentMediaElement
                kind="image"
                src={url}
                title={alt}
                className="max-w-full max-h-[85vh] object-contain rounded-lg"
              />
            ))}
          {caption && <p className="mt-2 text-sm text-[var(--overlay-fg-muted)]">{caption}</p>}
          {gallery ? <ArtworkGalleryNavigation gallery={gallery} arrows={!children && !composerSlot} /> : null}
          {annotationUnavailableReason && (
            <p role="status" className="mt-2 text-sm text-[var(--overlay-fg-muted)]">
              {annotationUnavailableReason}
            </p>
          )}
          {(workspaceError || openError) && (
            <p role="alert" className="mt-2 text-sm text-[var(--overlay-fg)]">
              {workspaceError || openError}
            </p>
          )}
          {!children && !composerSlot && mediaType === 'image' && <CopyButton url={url} />}
          {composerSlot}
        </div>
      </div>
    </ArtworkChromeProvider>,
    document.body,
  );
}
