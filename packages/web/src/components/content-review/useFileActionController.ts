'use client';
import { fileContentKind } from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { artworkActionsCopy } from './artwork-actions.shell-copy';
import { fileMenuItems } from './FileActionMenu';
import {
  type ContentFileInfo,
  contentFileInfo,
  copyArtworkPixels,
  copyContentText,
  fileSourceUrl,
} from './file-action-client';
import type { FileActionsProps } from './file-actions-contract';
import { useFileMenuHover } from './useFileMenuHover';

type FileNotice = 'failed' | 'copiedFrame' | 'copiedImage' | 'copiedPath' | 'copiedLink' | 'copiedContent';

/** File operation state and lifetime; every entry renders these same operations. */
export function useFileActionController({
  source,
  filename,
  mime,
  src: providedSrc,
  mediaType,
  root,
  contextRef,
  target,
  visible = true,
  text,
  openOnHover = false,
  appearance = 'menu',
}: FileActionsProps) {
  const originalUrl = fileSourceUrl(source);
  const kind = fileContentKind(filename, mime);
  const src = providedSrc ?? (kind === 'image' ? originalUrl : null);
  const t = useShellCopy(artworkActionsCopy);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [info, setInfo] = useState<ContentFileInfo | null>(null);
  const [notice, setNotice] = useState<FileNotice | null>(null);
  const menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const generation = useRef(0);
  const initialFocus = useRef<HTMLElement | null>(null);
  const focusOnOpen = useRef(true);
  useLayoutEffect(() => {
    const slot = target;
    return () => {
      // A decoded owner replaces the preview's buttons. Keep keyboard ownership
      // in the stable floating header only when those disappearing buttons had it.
      if (
        visible &&
        slot?.getAttribute('tabindex') === '-1' &&
        document.activeElement !== slot &&
        slot.contains(document.activeElement)
      )
        slot.focus({ preventScroll: true });
    };
  }, [target, visible]);
  const isVideo = mediaType === 'video' || !!mime?.startsWith('video/');
  const link = originalUrl;
  const feedback = (message: FileNotice) => {
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
  useEffect(() => {
    // Retained Workspace tabs keep their DOM; a top-layer menu must not outlive
    // the active surface or reopen when that retained tab becomes visible again.
    if (!visible) setPosition(null);
  }, [visible]);
  const closeMenu = () => {
    if (menu.current?.contains(document.activeElement)) {
      const origin = trigger.current ?? contextRef?.current?.querySelector<HTMLButtonElement>('button');
      origin?.focus({ preventScroll: true });
    }
    setPosition(null);
  };
  const perform = async (action: () => Promise<void | FileNotice>, message?: FileNotice) => {
    const scope = generation.current;
    closeMenu();
    try {
      const result = await action();
      if (scope === generation.current && (message || result)) feedback(message ?? result!);
    } catch {
      if (scope === generation.current) feedback('failed');
    }
  };
  const copyPixels = () =>
    perform(
      async () => {
        const element = root?.current?.querySelector('img,video') ?? (!isVideo ? new Image() : null);
        if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement) || !src)
          throw new Error('media_unavailable');
        await copyArtworkPixels(element, src);
      },
      isVideo ? 'copiedFrame' : 'copiedImage',
    );
  const copyLocation = () =>
    perform(async () => {
      const facts = info ?? (await contentFileInfo(source));
      await navigator.clipboard.writeText(facts.local && facts.path ? facts.path : (link ?? ''));
      return facts.local ? 'copiedPath' : 'copiedLink';
    });
  const refreshInfo = () => {
    const scope = generation.current;
    return contentFileInfo(source)
      .then((value) => {
        if (scope === generation.current) setInfo(value);
      })
      .catch(() => {
        if (scope === generation.current) feedback('failed');
      });
  };
  useEffect(() => {
    if (appearance === 'classic' && visible && link) void refreshInfo();
  }, [appearance, visible, link]);
  const openMenu = (x: number, y: number, focus = true) => {
    initialFocus.current = null;
    focusOnOpen.current = focus;
    setInfo(null);
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - 308)),
      y: Math.max(8, Math.min(y, window.innerHeight - 550)),
    });
    void refreshInfo();
  };
  useFileMenuHover(
    contextRef,
    menu,
    visible && !!link && openOnHover,
    (owner) => {
      const rect = owner.getBoundingClientRect();
      openMenu(rect.right, rect.bottom, false);
    },
    () => setPosition(null),
  );
  useEffect(() => {
    if (!visible || !link) return;
    const element = contextRef?.current;
    if (!element) return;
    const context = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.clientX, event.clientY);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        event.stopPropagation();
        const rect = element.getBoundingClientRect();
        openMenu(rect.right, rect.bottom);
      }
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
      if (!src || !owner?.contains(document.activeElement)) return;
      event.preventDefault();
      void copyPixels();
    };
    element.addEventListener('contextmenu', context);
    element.addEventListener('keydown', key);
    document.addEventListener('keydown', copy);
    return () => {
      element.removeEventListener('contextmenu', context);
      element.removeEventListener('keydown', key);
      document.removeEventListener('keydown', copy);
    };
  });
  useEffect(() => {
    if (!position || !focusOnOpen.current) return;
    // A delayed local file-info inserts Finder before the temporary first enabled item.
    // Keep the default at the first item, but never steal focus after the reader navigated.
    const first = fileMenuItems(menu.current)[0];
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
  const canCopyContent = text !== undefined || ['markdown', 'html', 'jsx', 'text'].includes(kind);
  const copyContent = () => perform(() => copyContentText(source, text), 'copiedContent');
  return {
    src,
    isVideo,
    link,
    t,
    position,
    setPosition,
    info,
    notice,
    menu,
    trigger,
    perform,
    copyPixels,
    copyLocation,
    copyContent,
    canCopyContent,
    openMenu,
    closeMenu,
  };
}
