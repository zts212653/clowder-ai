import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { observeMediaPresentation } from '@/components/workbench/content-review/observe-media-presentation';
import { ArtworkActionsVisibility } from './ArtworkChrome';
import type { FloatingArtwork } from './ArtworkLightboxScope';
import { ArtworkPreviewMedia } from './ArtworkPreviewMedia';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import styles from './artwork-lightbox.module.css';

/** The original owner still loads normally. Its decoded pixels replace the
 * already displayed Chat preview; preview bytes never become an annotation source. */
export function ArtworkOpeningPreview({ work, children }: { work: FloatingArtwork; children?: ReactNode }) {
  return work.ownerContentOnly ? children : <MediaOpeningPreview work={work}>{children}</MediaOpeningPreview>;
}

function MediaOpeningPreview({ work, children }: { work: FloatingArtwork; children?: ReactNode }) {
  const owner = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'version' | 'media' | 'ready' | 'unavailable'>('version');
  const t = useShellCopy(artworkActionsCopy);
  const showOwner = phase === 'ready' || phase === 'unavailable';
  useLayoutEffect(() => {
    const root = owner.current;
    if (!root || showOwner) return;
    let media: HTMLImageElement | HTMLVideoElement | null = null;
    let src = '';
    let stop: (() => void) | undefined;
    let handoff: { seconds: number; playing: boolean } | undefined;
    let previewUsed = false;
    const previewRoot = preview.current;
    const notePreviewUse = () => {
      previewUsed = true;
    };
    for (const event of ['seeking', 'play']) previewRoot?.addEventListener(event, notePreviewUse, true);
    const scan = () => {
      // Only the owner declares that opening is blocked. An alert can be an
      // ancillary draft/storage warning while its media is still decoding.
      if (root.querySelector('[data-content-opening-state="blocked"]')) {
        setPhase('unavailable');
        return;
      }
      const node = root.querySelector<HTMLImageElement | HTMLVideoElement>(
        '[data-testid="workspace-content-review-media"], [data-testid="workspace-file-viewer"] video, [data-testid="workspace-file-viewer"] img',
      );
      if (node === media && (node?.src ?? '') === src) return;
      stop?.();
      media = node;
      src = node?.src ?? '';
      setPhase(node ? 'media' : 'version');
      stop = node
        ? observeMediaPresentation(node, (ready) => {
            if (!ready) return;
            const player = preview.current?.querySelector('video');
            if (node instanceof HTMLVideoElement && player) {
              if (!handoff) {
                // An untouched new preview starts at zero. It must not erase the
                // original owner's retained position, but an explicit rewind must win.
                const usePreview = previewUsed || player.currentTime > 0.01 || !player.paused;
                handoff = {
                  seconds: usePreview ? Math.min(player.currentTime, node.duration) : node.currentTime,
                  playing: usePreview ? !player.paused : !node.paused,
                };
                player.pause();
                node.pause();
                if (Number.isFinite(handoff.seconds) && Math.abs(node.currentTime - handoff.seconds) > 0.01) {
                  node.currentTime = handoff.seconds;
                  return; // The verified player must present its own frame at this position.
                }
              }
              if (handoff.playing) void node.play().catch(() => {});
            }
            setPhase('ready');
          })
        : undefined;
    };
    const mutation = new MutationObserver(scan);
    mutation.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'data-content-opening-state', 'data-testid'],
    });
    scan();
    return () => {
      mutation.disconnect();
      stop?.();
      for (const event of ['seeking', 'play']) previewRoot?.removeEventListener(event, notePreviewUse, true);
    };
  }, [showOwner]);
  useLayoutEffect(() => {
    if (owner.current) owner.current.inert = !showOwner;
  }, [showOwner]);
  const loading = work.pending || !!work.surface;
  return (
    <div className={styles.opening} data-testid="artwork-opening-preview">
      <div ref={owner} className={styles.openingOwner} aria-hidden={!showOwner}>
        <ArtworkActionsVisibility visible={showOwner}>{children}</ArtworkActionsVisibility>
      </div>
      {!showOwner ? (
        <div ref={preview} className={styles.openingMedia} data-testid="artwork-chat-preview">
          <ArtworkPreviewMedia
            url={work.url}
            title={work.alt}
            video={work.mediaType === 'video'}
            gallery={work.gallery}
          />
          {loading ? (
            <p role="status" className="shrink-0 px-3 py-1 text-xs text-cafe-muted">
              {work.pending ? t.checkingPreview : phase === 'media' ? t.loadingOriginal : t.loadingVersion}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
