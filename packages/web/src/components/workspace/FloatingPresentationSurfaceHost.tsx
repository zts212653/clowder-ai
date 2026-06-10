'use client';

import { useEffect, useState } from 'react';
import type { FileData } from '@/hooks/useWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { PresentationFloatView } from './PresentationFloatView';

/**
 * F226 Presentation Surface — container that wires the floating window to the store + file fetch.
 *
 * MUST be mounted at AppShell/root level (NOT inside ChatContainer): the float has to survive
 * both ① workspace mode-tab switches and ② full-page route changes (/memory etc.). createPortal
 * alone is NOT enough — survival is decided by the React owner, so the host lives above the
 * (chat) route group (KD-1, 砚砚 review). Render/UI lives in the SSR-testable PresentationFloatView.
 */
export function FloatingPresentationSurfaceHost() {
  const surface = useChatStore((s) => s.presentationSurface);
  const dockBack = useChatStore((s) => s.dockBack);
  const closeFloat = useChatStore((s) => s.closeFloat);
  const minimizeFloat = useChatStore((s) => s.minimizeFloat);
  const setFloatPos = useChatStore((s) => s.setFloatPos);
  const setFloatSize = useChatStore((s) => s.setFloatSize);
  const toggleMaximize = useChatStore((s) => s.toggleMaximize);

  const [file, setFile] = useState<FileData | null>(null);
  const worktreeId = surface?.content.worktreeId ?? null;
  const filePath = surface?.content.filePath ?? null;
  const fileKind = surface?.content.fileKind ?? 'file';

  // Fetch text content (image kinds render via raw URL, no JSON fetch needed)
  useEffect(() => {
    let cancelled = false;
    if (!worktreeId || !filePath || fileKind === 'image') {
      setFile(null);
      return;
    }
    const params = new URLSearchParams({ worktreeId, path: filePath });
    apiFetch(`/api/workspace/file?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setFile(data as FileData | null);
      })
      .catch(() => {
        if (!cancelled) setFile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [worktreeId, filePath, fileKind]);

  // Esc closes the float — defer to any higher-priority overlay (烁烁 P2-6)
  useEffect(() => {
    if (!surface) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Defer Esc only to an INTERACTIVE fullscreen overlay (ConfirmDialog / VoteConfigModal /
      // SteerQueuedEntryModal / BrakeModal / Lightbox — all "fixed inset-0" regardless of role).
      // Exclude non-interactive backdrops: some (e.g. MobileStatusSheet) render permanently and
      // only toggle visibility via pointer-events-none / hidden / invisible — those must NOT block
      // Esc (砚砚 R4). The float is react-rnd (absolute), so it never matches .fixed.inset-0 itself.
      if (document.querySelector('.fixed.inset-0:not(.pointer-events-none):not(.hidden):not(.invisible)')) {
        return;
      }
      closeFloat();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [surface, closeFloat]);

  if (!surface) return null;
  const c = surface.content;
  const rawSrc = `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(
    c.worktreeId ?? '',
  )}&path=${encodeURIComponent(c.filePath)}`;

  return (
    <PresentationFloatView
      content={c}
      pos={surface.pos}
      size={surface.size}
      minimized={surface.minimized}
      maximized={surface.maximized}
      fileContent={file?.content ?? null}
      rawSrc={rawSrc}
      onDockBack={dockBack}
      onClose={closeFloat}
      onMinimize={minimizeFloat}
      onDragStop={setFloatPos}
      onResizeStop={(pos, size) => {
        setFloatPos(pos);
        setFloatSize(size);
      }}
      onToggleMaximize={toggleMaximize}
    />
  );
}
