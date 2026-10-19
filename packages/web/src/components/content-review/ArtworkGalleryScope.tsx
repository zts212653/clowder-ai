'use client';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useComposerContextAttachments } from '@/components/useComposerContextAttachments';
import { useChatStore } from '@/stores/chatStore';
import type { FloatingArtwork } from './ArtworkLightboxScope';
import type { ArtworkGallery } from './artwork-gallery';
import { sameGalleryGroup } from './media-chat-selection';

const ReferenceContext = createContext<FloatingArtwork['reference']>(undefined);
export function useArtworkReference() {
  return useContext(ReferenceContext);
}
const Context = createContext<ArtworkGallery | undefined>(undefined);
export function useArtworkGallery() {
  return useContext(Context);
}
export function ArtworkGalleryScope({
  gallery,
  reference,
  children,
}: {
  gallery?: ArtworkGallery;
  reference?: FloatingArtwork['reference'];
  children: ReactNode;
}) {
  const threadId = useChatStore((state) => state.currentThreadId);
  const attachments = useComposerContextAttachments(threadId ?? '');
  const counted = useMemo(() => {
    if (!gallery) return undefined;
    const origin = gallery.items[gallery.index]?.origin;
    const selectionCounts: Record<number, number> = { ...gallery.selectionCounts };
    const draftCounts: Record<number, number> = {};
    for (const item of attachments) {
      if (item.kind !== 'media' || !origin || !item.gallery || !sameGalleryGroup(origin, item.gallery)) continue;
      draftCounts[item.gallery.index] = (draftCounts[item.gallery.index] ?? 0) + item.selections.length;
    }
    return { ...gallery, selectionCounts: { ...selectionCounts, ...draftCounts } };
  }, [gallery, attachments]);
  return (
    <ReferenceContext.Provider value={reference}>
      <Context.Provider value={counted}>{children}</Context.Provider>
    </ReferenceContext.Provider>
  );
}
