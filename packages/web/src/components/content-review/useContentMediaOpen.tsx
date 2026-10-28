'use client';

import { type MessageMediaItemSelector, messageMediaItemKey } from '@cat-cafe/shared';
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Lightbox } from '@/components/Lightbox';
import { isGalleryApiUrl, resolveGalleryMediaUrl } from '@/components/rich/useGalleryMediaUrls';
import { resolvePublicationTarget } from '@/components/workbench/publication-surface';
import { createFileSurface } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { type FloatingArtwork, useArtworkLightboxScope } from './ArtworkLightboxScope';
import type { ArtworkGalleryItem } from './artwork-gallery';
import { artworkLightboxSurface } from './artwork-lightbox-surface';
import { type ContentOpenSource } from './content-open-source';
import { useChatArtworkEntry } from './useChatArtworkEntry';
import { type ArtworkOpenResult, type PublishedMessageCoordinate } from './usePublishedContent';

type Entry = ReturnType<ReturnType<typeof useChatArtworkEntry>['source']>;
export type MediaOpenInput = ArtworkGalleryItem & {
  entry: Entry;
  item?: MessageMediaItemSelector;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  admitted?: ArtworkOpenResult;
  workspaceTarget?: Parameters<typeof createFileSurface>[0];
  gallery?: import('./artwork-gallery').ArtworkGallery;
};
type Input = MediaOpenInput;
type Preview = Input & { reason?: string; hostThreadId: string; gallery?: FloatingArtwork['gallery'] };

/** Media presentation never resolves a different owner; only the selected source is admitted. */
export function useContentMediaOpen({
  artwork,
  scopeRef,
  hostThreadId,
  publication,
  sourceScopeKey,
  navigation,
  setNavigating,
  openContent,
}: {
  artwork: ReturnType<typeof useChatArtworkEntry>;
  scopeRef: MutableRefObject<ReturnType<typeof useArtworkLightboxScope>>;
  hostThreadId: string;
  publication?: PublishedMessageCoordinate;
  sourceScopeKey?: string;
  navigation: MutableRefObject<number>;
  setNavigating: Dispatch<SetStateAction<boolean>>;
  openContent: (source: ContentOpenSource, mode?: 'lightbox' | 'work-mode') => Promise<boolean>;
}) {
  const scope = scopeRef.current;
  const ownedGeneration = useRef<number>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const pendingGeneration = useRef<number>();
  const currentGeneration = scope?.getGeneration();
  useEffect(() => {
    if (pendingGeneration.current !== undefined && pendingGeneration.current !== currentGeneration) {
      pendingGeneration.current = undefined;
      navigation.current++;
      setNavigating(false);
    }
  }, [currentGeneration]);
  const invalidateNavigation = useCallback(() => {
    navigation.current++;
  }, []);
  useEffect(() => {
    setPreview((current) => (current && current.hostThreadId !== hostThreadId ? null : current));
    return invalidateNavigation;
  }, [hostThreadId, sourceScopeKey, invalidateNavigation]);

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
    let generation = initialScope?.getGeneration();
    const earlyPreview = mode === 'lightbox' && artwork.isV2 && initialScope && !!input.url;
    const isCurrent = () =>
      navigation.current === ticket &&
      useChatStore.getState().currentThreadId === hostThreadId &&
      (!initialScope || scopeRef.current?.getGeneration() === generation);
    if (earlyPreview) {
      if (!initialScope.open({ ...input, surface: null, pending: true }, generation)) return false;
      generation = initialScope.getGeneration();
      ownedGeneration.current = generation;
      pendingGeneration.current = generation;
    }
    setNavigating(true);
    try {
      // The selected item already has its rendered URL. Neither sibling locator
      // reads nor owner admission need to delay those already visible pixels.
      const [selectedGroup, result] = await Promise.all([
        group ?? groupFor(input),
        input.admitted ?? artwork.open(input.entry, input.title, 'lightbox', isCurrent),
      ]);
      if (!isCurrent()) return false;
      const selected = selectedGroup?.items[selectedGroup.index] ?? input;
      if (isCurrent() && result.status === 'blocked' && earlyPreview) initialScope.close();
      if (!isCurrent() || result.status === 'blocked' || (mode === 'work-mode' && result.status !== 'opened'))
        return false;
      const target =
        result.status === 'opened'
          ? {
              ...(result.target.kind === 'file' ? selected.workspaceTarget : {}),
              ...result.target,
              ...(selected.navigationOrigin ? { navigationOrigin: selected.navigationOrigin } : {}),
            }
          : null;
      if (mode === 'work-mode' && target) {
        const store = useChatStore.getState();
        captureChatReadingBeforeLayoutChange();
        if (
          !(target.kind === 'file'
            ? store.openWorkspacePath(hostThreadId, target, 'work-mode')
            : store.openPublication(target, hostThreadId, 'work-mode'))
        )
          return false;
      }
      const gallery =
        input.gallery ??
        (selectedGroup
          ? {
              items: selectedGroup.items,
              index: selectedGroup.index,
              onSelect: (index: number) => {
                if (index >= 0 && index < selectedGroup.items.length && index !== selectedGroup.index)
                  void show(selectedGroup.items[index], mode, { ...selectedGroup, index });
              },
            }
          : undefined);
      const work: FloatingArtwork = {
        ...selected,
        gallery,
        surface:
          result.status === 'opened'
            ? {
                ...artworkLightboxSurface(target!, selected.title),
                ...(selected.navigationOrigin ? { navigationOrigin: selected.navigationOrigin } : {}),
              }
            : null,
        ...(result.status === 'preview' ? { reason: result.reason } : {}),
        ...(selected.entry || selected.admitted?.status === 'opened'
          ? {
              openWorkspace: () => {
                const actual = scopeRef.current?.work?.surface;
                const current = actual ? resolvePublicationTarget(actual) : null;
                return current &&
                  (!selected.entry ||
                    result.status !== 'opened' ||
                    result.target.kind !== 'publication' ||
                    current.contentRef !== result.target.contentRef ||
                    current.ownerRevision !== result.target.ownerRevision)
                  ? openContent(
                      { kind: 'work', reference: current, title: selected.title, origin: actual?.navigationOrigin },
                      'work-mode',
                    )
                  : show(selected, 'work-mode', selectedGroup);
              },
            }
          : {}),
      };
      if (initialScope && artwork.isV2) {
        const applied =
          mode === 'work-mode'
            ? initialScope.enterWorkMode(work, generation)
            : earlyPreview
              ? initialScope.update(work, generation!)
              : initialScope.open(work, generation);
        if (applied) {
          ownedGeneration.current = initialScope.getGeneration();
          setPreview(null);
        }
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
        ...(result.status === 'preview' && artwork.isV2 ? { reason: result.reason } : {}),
      });
      return true;
    } catch {
      if (earlyPreview && isCurrent())
        initialScope.update(
          { ...input, surface: null, reason: '原作品信息暂时无法读取，当前仅显示聊天预览。' },
          generation!,
        );
      return false;
    } finally {
      if (ticket === navigation.current) setNavigating(false);
    }
  }
  return {
    show,
    cancel: () => {
      navigation.current++;
      setNavigating(false);
      setPreview(null);
      if (ownedGeneration.current !== undefined && scopeRef.current?.getGeneration() === ownedGeneration.current)
        scopeRef.current.close();
      ownedGeneration.current = undefined;
    },
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
        onOpenWorkspace={
          preview.entry || preview.admitted?.status === 'opened' ? () => show(preview, 'work-mode') : undefined
        }
        onClose={() => {
          navigation.current++;
          setPreview(null);
        }}
      />
    ) : null,
  };
}
