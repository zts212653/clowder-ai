'use client';
import type { ContextAttachment, MediaContextAttachment, MediaGalleryOrigin } from '@cat-cafe/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useComposerContextAttachments } from '@/components/useComposerContextAttachments';
import { useChatStore } from '@/stores/chatStore';
import type { FloatingArtwork } from './ArtworkLightboxScope';
import type { ArtworkGallery } from './artwork-gallery';
import { sameGalleryGroup } from './media-chat-selection';
import { useLiveArtworkReference } from './useLiveArtworkReference';

const ReferenceContext = createContext<FloatingArtwork['reference']>(undefined);
export function useArtworkReference() {
  return useContext(ReferenceContext);
}
const SourceContext = createContext<MediaContextAttachment['source'] | undefined>(undefined);
/** The open media stays pinned to its original owner even when an opinion is removed. */
export function useRetainedArtworkSource() {
  return useContext(SourceContext);
}
const Context = createContext<ArtworkGallery | undefined>(undefined);
export function useArtworkGallery() {
  return useContext(Context);
}
function gallerySelectionCounts(attachments: readonly ContextAttachment[], origin?: MediaGalleryOrigin) {
  const counts: Record<number, number> = {};
  if (!origin) return counts;
  for (const item of attachments) {
    if (item.kind !== 'media' || !item.gallery || !sameGalleryGroup(origin, item.gallery)) continue;
    counts[item.gallery.index] = (counts[item.gallery.index] ?? 0) + item.selections.length;
  }
  return counts;
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
  const live = useLiveArtworkReference(reference);
  const counted = useMemo(() => {
    if (!gallery) return undefined;
    const origin = gallery.items[gallery.index]?.origin;
    const counts = reference?.origin ? gallerySelectionCounts(live.attachments ?? [], origin) : gallery.selectionCounts;
    return { ...gallery, selectionCounts: { ...counts, ...gallerySelectionCounts(attachments, origin) } };
  }, [gallery, attachments, live.attachments, reference?.origin]);
  return (
    <SourceContext.Provider value={reference?.attachment.source}>
      <ReferenceContext.Provider value={live.reference}>
        <Context.Provider value={counted}>{children}</Context.Provider>
      </ReferenceContext.Provider>
    </SourceContext.Provider>
  );
}
