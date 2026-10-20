'use client';
import { type RefObject, useEffect, useRef, useState } from 'react';

/** Fullscreen changes presentation only: never replace the video, its source or the host mode. */
export function useArtworkVideoFullscreen(
  player: RefObject<HTMLElement> | undefined,
  video: RefObject<HTMLVideoElement>,
) {
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  const toggle = () => {
    const node = player?.current;
    if (!node || busy.current) return;
    setFailed(false);
    busy.current = true;
    try {
      const operation =
        node.ownerDocument.fullscreenElement === node ? node.ownerDocument.exitFullscreen() : node.requestFullscreen();
      void operation
        .catch(() => setFailed(true))
        .finally(() => {
          busy.current = false;
        });
    } catch {
      busy.current = false;
      setFailed(true);
    }
  };
  useEffect(() => {
    const node = player?.current;
    if (!node) return;
    const doc = node.ownerDocument;
    const update = () => setActive(doc.fullscreenElement === node);
    update();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && doc.fullscreenElement === node) {
        // Exit the player while keeping its surrounding artwork host mounted.
        event.preventDefault();
        event.stopPropagation();
        toggle();
        return;
      }
      if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (event.key.toLowerCase() !== 'f') return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')
      )
        return;
      if (!node.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"]')) return;
      const dialog = doc.querySelector('[role="dialog"][aria-modal="true"]');
      if (dialog && !dialog.contains(node)) return;
      if (!dialog && target instanceof Element && !node.contains(target)) {
        const visible = [...doc.querySelectorAll<HTMLElement>('[data-artwork-video-player]')].filter(
          (item) => item.getClientRects().length && !item.closest('[hidden],[inert],[aria-hidden="true"]'),
        );
        if (visible.length !== 1 || visible[0] !== node) return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    const doubleClick = (event: MouseEvent) => {
      if (event.target !== video.current) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    doc.addEventListener('fullscreenchange', update);
    doc.addEventListener('keydown', key, true);
    node.addEventListener('dblclick', doubleClick);
    return () => {
      doc.removeEventListener('fullscreenchange', update);
      doc.removeEventListener('keydown', key, true);
      node.removeEventListener('dblclick', doubleClick);
    };
  });
  return { active, failed, toggle, available: !!player };
}
