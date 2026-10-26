'use client';
import type { WorkReference } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { artworkLightboxSurface } from '@/components/content-review/artwork-lightbox-surface';
import { Lightbox } from '@/components/Lightbox';
import { resolvePublicationTarget } from '@/components/workbench/publication-surface';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { readWorkCardDescription, type WorkCardDescription } from './useWorkCardDescription';

type WorkCardSelection = { reference: WorkReference; title: string; navigationOrigin?: WorkspaceFileNavigationOrigin };
type Preview = { url: string; video: boolean; selection: WorkCardSelection };
type Presentation = 'lightbox' | 'work-mode';

export function useWorkCardOpen(reference: WorkReference | undefined, title: string, messageId?: string) {
  const scope = useArtworkLightboxScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const hostThreadId = useChatStore((state) => state.currentThreadId);
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState<WorkCardDescription | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed owner/thread invalidates its pending navigation and local preview.
  useEffect(() => {
    sequence.current++;
    setBusy(false);
    setError(null);
    setDescription(null);
    setPreview(null);
    return () => {
      sequence.current++;
    };
  }, [hostThreadId, reference?.contentRef, reference?.ownerRevision]);

  function present(mode: Presentation, selection: WorkCardSelection, result: WorkCardDescription, generation?: number) {
    const shown = {
      ...selection,
      reference: { contentRef: selection.reference.contentRef, ownerRevision: result.asset.ownerRevision },
    };
    const navigationOrigin =
      shown.navigationOrigin ??
      (messageId && hostThreadId ? { kind: 'chat-file-link' as const, threadId: hostThreadId, messageId } : undefined);
    const target = {
      kind: 'publication' as const,
      ...shown.reference,
      title: shown.title,
      ...(navigationOrigin ? { navigationOrigin } : {}),
    };
    if (mode === 'work-mode') {
      captureChatReadingBeforeLayoutChange();
      if (!hostThreadId || !useChatStore.getState().openPublication(target, hostThreadId, 'work-mode'))
        throw new Error('原作品暂时无法打开，请重试。');
      scope?.close();
      setPreview(null);
      return true;
    }
    const url = `${API_URL}/api/content-publications/${encodeURIComponent(shown.reference.contentRef)}/media/${shown.reference.ownerRevision}`;
    const video = result.asset.mediaType.startsWith('video/');
    // The floating owner may have selected another version since this card first opened it.
    if (scope)
      return scope.open(
        {
          url,
          title: shown.title,
          alt: shown.title,
          mediaType: video ? 'video' : 'image',
          surface: artworkLightboxSurface(target, shown.title),
          openWorkspace: () => {
            const surface = scopeRef.current?.work?.surface;
            const target = surface ? resolvePublicationTarget(surface) : null;
            if (!surface || target?.contentRef !== shown.reference.contentRef) return Promise.resolve(false);
            return open('work-mode', false, { ...shown, reference: target }, surface.ownerStateRef.key);
          },
        },
        generation,
      );
    setPreview({ url, video, selection: shown });
    return true;
  }
  async function open(
    mode: Presentation,
    current = false,
    selection?: WorkCardSelection,
    expectedSurfaceKey?: string,
  ): Promise<boolean> {
    const selected = selection ?? (reference ? { reference, title } : null);
    if (!selected || !hostThreadId) return false;
    const ticket = ++sequence.current,
      generation = scope?.getGeneration();
    const valid = () =>
      ticket === sequence.current &&
      useChatStore.getState().currentThreadId === hostThreadId &&
      (!scope || scope.getGeneration() === generation) &&
      (expectedSurfaceKey === undefined || scopeRef.current?.work?.surface?.ownerStateRef.key === expectedSurfaceKey);
    setBusy(true);
    setError(null);
    try {
      const result = await readWorkCardDescription(selected.reference, current);
      if (!valid()) return false;
      setDescription(result);
      return present(mode, selected, result, generation);
    } catch (failure) {
      if (valid()) setError(failure instanceof Error ? failure.message : '原作品暂时无法打开。');
      return false;
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }
  return {
    open,
    busy,
    error,
    description,
    lightbox: preview ? (
      <Lightbox
        url={preview.url}
        alt={preview.selection.title}
        mediaType={preview.video ? 'video' : 'image'}
        onClose={() => {
          sequence.current++;
          setPreview(null);
        }}
        onOpenWorkspace={() => open('work-mode', false, preview.selection)}
      />
    ) : null,
  };
}
