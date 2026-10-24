'use client';
import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { isGalleryApiUrl, resolveGalleryMediaUrl } from '@/components/rich/useGalleryMediaUrls';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { type FloatingArtwork, useArtworkLightboxScope } from './ArtworkLightboxScope';
import { artworkLightboxSurface } from './artwork-lightbox-surface';
import { mediaAttachmentUrl, readMediaAttachmentOwner } from './media-attachment-owner';
import { composerAttachments } from './media-chat-composer';
import { sameGalleryGroup } from './media-chat-selection';
import { readOriginalGallery } from './read-original-gallery';
import { useChatArtworkEntry } from './useChatArtworkEntry';

/** Presentation of an existing draft/message reference; never re-publishes, rewrites, sends or takes over that reference. */
export function useGalleryAttachmentOpen(
  references: readonly MediaContextAttachment[],
  message?: { threadId: string; messageId: string },
  fromComposer = false,
) {
  const scope = useArtworkLightboxScope();
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const pendingGeneration = useRef<number>();
  const currentGeneration = scope?.getGeneration();
  useEffect(() => {
    if (pendingGeneration.current !== undefined && pendingGeneration.current !== currentGeneration) {
      pendingGeneration.current = undefined;
      sequence.current++;
      setBusy(false);
    }
  }, [currentGeneration]);
  const artwork = useChatArtworkEntry();
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const open = async (attachment: MediaContextAttachment, selectionId?: string) => {
    const origin = attachment.gallery;
    const threadId = useChatStore.getState().currentThreadId;
    const owner = currentScope.current;
    if (!origin || !threadId || !owner || owner.threadId !== threadId) {
      setError('请在原聊天中打开这处圈选。');
      return;
    }
    const previewUrl = mediaAttachmentUrl(attachment);
    if (
      !previewUrl ||
      !owner.open(
        {
          url: previewUrl,
          title: attachment.title,
          alt: attachment.title,
          mediaType: attachment.mediaType.startsWith('video/') ? 'video' : 'image',
          surface: null,
          pending: true,
        },
        owner.getGeneration(),
      )
    )
      return;
    let ticket = ++sequence.current;
    const generation = owner.getGeneration();
    pendingGeneration.current = generation;
    const isCurrent = () =>
      sequence.current === ticket &&
      useChatStore.getState().currentThreadId === threadId &&
      currentScope.current?.getGeneration() === generation;
    setBusy(true);
    setError(null);
    try {
      const original = await readOriginalGallery(origin);
      if (!isCurrent()) return;
      const items = await Promise.all(
        original.map(async (item, index) => {
          const raw = await resolveGalleryMediaUrl(item.url);
          return {
            ...item,
            url: raw ? (isGalleryApiUrl(raw) ? API_URL + raw : raw) : '',
            entry: raw ? artwork.source(raw, item.item, origin) : null,
            origin: { ...origin, index, item: item.item },
          };
        }),
      );
      const stored = [
        ...references,
        ...composerAttachments(threadId).filter((item): item is MediaContextAttachment => item.kind === 'media'),
      ];
      const referenceFor = (index: number) =>
        stored.find((item) => item.gallery && sameGalleryGroup(origin, item.gallery) && item.gallery.index === index);
      const show = async (
        index: number,
        mode: 'lightbox' | 'work-mode',
        place?: string,
        previewGeneration?: number,
      ): Promise<boolean> => {
        const active = currentScope.current;
        if (!active || useChatStore.getState().currentThreadId !== threadId) return false;
        let stamp = active.getGeneration();
        if (previewGeneration !== undefined && previewGeneration !== stamp) return false;
        const visit = ++sequence.current;
        const valid = () =>
          visit === sequence.current &&
          currentScope.current?.getGeneration() === stamp &&
          useChatStore.getState().currentThreadId === threadId;
        const selected = items[index],
          reference = index === origin.index ? attachment : referenceFor(index);
        if (!selected) return false;
        if (mode === 'lightbox' && previewGeneration === undefined) {
          const url = reference ? mediaAttachmentUrl(reference) : selected.url;
          if (!url || !active.open({ ...selected, url, surface: null, pending: true }, stamp)) return false;
          stamp = active.getGeneration();
          pendingGeneration.current = stamp;
        }
        try {
          const read = reference ? await readMediaAttachmentOwner(reference) : null;
          const opened = read
            ? { status: 'opened' as const, target: read.target }
            : await artwork.open(selected.entry, selected.title, 'lightbox', valid);
          if (!valid()) return false;
          if (opened.status !== 'opened') {
            if (mode === 'lightbox') active.close();
            setError('原作品版本当前无法打开。');
            return false;
          }
          if (mode === 'work-mode') {
            captureChatReadingBeforeLayoutChange();
            const state = useChatStore.getState();
            if (
              !(opened.target.kind === 'file'
                ? state.openWorkspacePath(threadId, opened.target, 'work-mode')
                : state.openPublication(opened.target, threadId, 'work-mode'))
            )
              return false;
          }
          const work: FloatingArtwork = {
            ...selected,
            ...(read ? { url: read.url } : {}),
            surface: read?.surface ?? artworkLightboxSurface(opened.target, selected.title),
            gallery: {
              items,
              index,
              selectionCounts: Object.fromEntries(items.map((_, at) => [at, referenceFor(at)?.selections.length ?? 0])),
              onSelect: (next) => {
                if (next >= 0 && next < items.length && next !== index) void show(next, mode);
              },
            },
            ...(reference
              ? {
                  reference: {
                    attachment: reference,
                    origin: message
                      ? { kind: 'message' as const, ...message }
                      : fromComposer
                        ? { kind: 'composer' as const, threadId }
                        : undefined,
                    ...(place ? { selectionId: place } : {}),
                  },
                }
              : {}),
            openWorkspace: () => show(index, 'work-mode', place),
          };
          return mode === 'work-mode' ? active.enterWorkMode(work, stamp) : active.update(work, stamp);
        } catch (failure) {
          if (valid()) {
            if (mode === 'lightbox') active.close();
            setError(failure instanceof Error ? failure.message : '原版本暂时无法打开。');
          }
          return false;
        }
      };
      if (isCurrent()) {
        const opening = show(origin.index, 'lightbox', selectionId, generation);
        ticket = sequence.current;
        await opening;
      }
    } catch (failure) {
      if (isCurrent()) {
        owner.close();
        setError(failure instanceof Error ? failure.message : '原图组暂时无法打开。');
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  return { open, busy, error };
}
