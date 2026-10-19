'use client';

import { type MessageMediaItemSelector, messageMediaItemKey } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Lightbox } from '@/components/Lightbox';
import { isGalleryApiUrl, resolveGalleryMediaUrl } from '@/components/rich/useGalleryMediaUrls';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { type FloatingArtwork, useArtworkLightboxScope } from './ArtworkLightboxScope';
import type { ArtworkGalleryItem } from './artwork-gallery';
import { artworkLightboxSurface } from './artwork-lightbox-surface';
import { useChatArtworkEntry } from './useChatArtworkEntry';
import type { PublishedMessageCoordinate } from './usePublishedContent';

type Entry = ReturnType<ReturnType<typeof useChatArtworkEntry>['source']>;
type Input = ArtworkGalleryItem & { entry: Entry; item?: MessageMediaItemSelector };
type Preview = Input & { reason?: string; hostThreadId: string; gallery?: FloatingArtwork['gallery'] };

/** Same original message and original owner, in either presentation. The composer is never recreated here. */
export function useChatArtworkLightbox(publication?: PublishedMessageCoordinate) {
  const artwork = useChatArtworkEntry(publication);
  const scope = useArtworkLightboxScope();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const hostThreadId = useChatStore((state) => state.currentThreadId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [navigating, setNavigating] = useState(false);
  const navigation = useRef(0);
  const invalidateNavigation = useCallback(() => {
    navigation.current++;
  }, []);
  useEffect(() => {
    setPreview((current) => (current && current.hostThreadId !== hostThreadId ? null : current));
    return invalidateNavigation;
  }, [hostThreadId, invalidateNavigation]);

  async function groupFor(input: Input): Promise<{ items: Input[]; index: number } | undefined> {
    if (!publication || !input.item || !publication.media?.length) return undefined;
    const index = publication.media.findIndex(
      (value) => messageMediaItemKey(value.item) === messageMediaItemKey(input.item!),
    );
    if (index < 0) return undefined;
    // Locator reads allow original thumbnails; only the selected item enters the content-publication owner below.
    const items = await Promise.all(
      publication.media.map(async (value, position): Promise<Input> => {
        const raw = await resolveGalleryMediaUrl(value.url);
        return {
          ...value,
          url: raw ? (isGalleryApiUrl(raw) ? API_URL + raw : raw) : '',
          entry: raw ? artwork.source(raw, value.item) : null,
          origin: {
            threadId: publication.threadId,
            messageId: publication.messageId,
            messageRevision: publication.messageRevision,
            item: value.item,
            index: position,
            count: publication.media!.length,
          },
        };
      }),
    );
    // The clicked item retains its actual rendered URL/entry, including already-resolved legacy local paths.
    items[index] = { ...items[index], ...input, origin: items[index].origin };
    return { items, index };
  }

  async function show(
    input: Input,
    mode: 'lightbox' | 'work-mode',
    group?: { items: Input[]; index: number },
  ): Promise<boolean> {
    const ticket = ++navigation.current;
    const initialScope = scopeRef.current;
    const generation = initialScope?.getGeneration();
    const isCurrent = () =>
      navigation.current === ticket &&
      useChatStore.getState().currentThreadId === hostThreadId &&
      (!initialScope || scopeRef.current?.getGeneration() === generation);
    setNavigating(true);
    try {
      const selectedGroup = group ?? (await groupFor(input));
      if (!isCurrent()) return false;
      const selected = selectedGroup?.items[selectedGroup.index] ?? input;
      const result = await artwork.open(selected.entry, selected.title, mode, isCurrent);
      if (!isCurrent() || result.status === 'blocked' || (mode === 'work-mode' && result.status !== 'opened'))
        return false;
      const gallery = selectedGroup
        ? {
            items: selectedGroup.items,
            index: selectedGroup.index,
            onSelect: (index: number) => {
              if (index >= 0 && index < selectedGroup.items.length && index !== selectedGroup.index)
                void show(selectedGroup.items[index], mode, { ...selectedGroup, index });
            },
          }
        : undefined;
      const work: FloatingArtwork = {
        ...selected,
        gallery,
        surface: result.status === 'opened' ? artworkLightboxSurface(result.target, selected.title) : null,
        ...(result.status === 'preview' ? { reason: result.reason } : {}),
        ...(selected.entry ? { openWorkspace: () => show(selected, 'work-mode', selectedGroup) } : {}),
      };
      if (initialScope && artwork.isV2) {
        const applied =
          mode === 'work-mode' ? initialScope.enterWorkMode(work, generation) : initialScope.open(work, generation);
        if (applied) setPreview(null);
        return applied;
      }
      if (mode === 'work-mode') {
        setPreview(null);
        return true;
      }
      setPreview({
        ...selected,
        gallery,
        hostThreadId,
        ...(result.status === 'preview' ? { reason: result.reason } : {}),
      });
      return true;
    } finally {
      if (ticket === navigation.current) setNavigating(false);
    }
  }
  const openWorkMode = (input: Input) => show(input, 'work-mode');
  return {
    ...artwork,
    busy: artwork.busy || navigating,
    enlarge: (input: Input) => show(input, 'lightbox'),
    openWorkMode,
    lightbox: preview ? (
      <Lightbox
        url={preview.url}
        alt={preview.alt}
        caption={preview.caption}
        mediaType={preview.mediaType}
        gallery={preview.gallery}
        annotationUnavailableReason={preview.reason}
        workspaceBusy={artwork.busy}
        workspaceError={artwork.error}
        onOpenWorkspace={preview.entry ? () => openWorkMode(preview) : undefined}
        onClose={() => {
          navigation.current++;
          setPreview(null);
        }}
      />
    ) : null,
  };
}
