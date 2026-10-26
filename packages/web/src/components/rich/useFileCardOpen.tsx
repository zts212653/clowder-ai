'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useWorkCardOpen } from '@/components/artifacts/useWorkCardOpen';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { useChatArtworkLightbox } from '@/components/content-review/useChatArtworkLightbox';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { createArtifactSurface } from '@/components/workbench/real-surface-adapters';
import type { RichFileBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { usePublishedFileOpen } from './usePublishedFileOpen';
import type { useRegisteredFileWork } from './useRegisteredFileWork';

export const isSafeFileUrl = (url: string) => /^(\/uploads\/|\/api\/|https:\/\/)/.test(url);
type Presentation = 'lightbox' | 'work-mode';
type Owner = 'registered' | 'media' | 'file';
export function useFileCardOpen({
  block,
  publication,
  host,
  originThread,
  messageId,
  sourceMessageIds,
  registered,
  video,
}: {
  block: RichFileBlock;
  publication?: PublishedMessageCoordinate;
  host: string | null;
  originThread?: string;
  messageId?: string;
  sourceMessageIds?: readonly string[];
  registered: ReturnType<typeof useRegisteredFileWork>;
  video: boolean;
}) {
  const opening = useWorkCardOpen(undefined, block.fileName, messageId);
  const published = useChatArtworkLightbox(publication);
  const legacy = usePublishedFileOpen(block.url, originThread, messageId, sourceMessageIds);
  const scope = useArtworkLightboxScope();
  const sequence = useRef(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [activeOwner, setActiveOwner] = useState<Owner>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: this identity fence also cancels a locator lookup after unmount or source changes.
  useEffect(() => {
    sequence.current++;
    setBusy(false);
    setError(null);
    setActiveOwner(undefined);
    return () => {
      sequence.current++;
    };
  }, [host, block.url]);

  async function openMedia(mode: Presentation) {
    setActiveOwner('media');
    const input = {
      url: block.url.startsWith('/') ? `${API_URL}${block.url}` : block.url,
      title: block.fileName,
      alt: block.fileName,
      mediaType: video ? ('video' as const) : ('image' as const),
      entry: published.source(block.url, { kind: 'rich-file', blockId: block.id }),
      item: { kind: 'rich-file' as const, blockId: block.id },
    };
    if (!input.entry && mode === 'work-mode') throw new Error('这份文件还没有可核对的作品入口，可以从菜单下载。');
    return mode === 'lightbox' ? published.enlarge(input) : published.openWorkMode(input);
  }
  function openFile(mode: Presentation, original: ThreadArtifactDTO, generation?: number) {
    if (!host) return false;
    const origin = messageId
      ? { kind: 'chat-file-link' as const, threadId: originThread ?? host, messageId }
      : undefined;
    if (mode === 'work-mode' || !scope) {
      captureChatReadingBeforeLayoutChange();
      useChatStore.getState().openPublishedArtifact(host, original, origin, 'work-mode');
      scope?.close();
      return true;
    }
    return scope.open(
      {
        url: block.url,
        title: original.name,
        alt: original.name,
        mediaType: 'image',
        ownerContentOnly: true,
        surface: createArtifactSurface({
          threadId: originThread ?? host,
          artifact: original,
          navigationOrigin: origin,
        }),
        openWorkspace: () => open('work-mode'),
      },
      generation,
    );
  }
  async function open(mode: Presentation, latest = false): Promise<boolean> {
    const ticket = ++sequence.current,
      generation = scope?.getGeneration();
    const valid = () =>
      ticket === sequence.current &&
      useChatStore.getState().currentThreadId === host &&
      (!scope || scope.getGeneration() === generation);
    setBusy(true);
    setError(null);
    setActiveOwner(undefined);
    try {
      if (!isSafeFileUrl(block.url)) return false;
      const work = await registered.resolve();
      if (!valid()) return false;
      const reference = work?.work ?? registered.reference;
      if (reference) {
        setActiveOwner('registered');
        return await opening.open(mode, latest, { reference, title: work?.name ?? block.fileName });
      }
      if (video || published.source(block.url, { kind: 'rich-file', blockId: block.id })) return await openMedia(mode);
      setActiveOwner('file');
      const original = await legacy.resolve();
      if (!valid()) return false;
      if (!original) throw new Error('暂时无法定位这份已发布材料，请重试打开。');
      if (original.work) {
        setActiveOwner('registered');
        return await opening.open(mode, latest, { reference: original.work, title: original.name });
      }
      return openFile(mode, original, generation);
    } catch (failure) {
      if (valid()) setError(failure instanceof Error ? failure.message : '原作品暂时无法打开。');
      return false;
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }
  const failures = {
    registered: opening.error,
    media: published.error,
    file: legacy.error ? '暂时无法定位这份已发布材料，请重试打开。' : null,
  };
  return {
    open,
    busy: busy || opening.busy || published.busy || legacy.loading,
    error: error ?? (activeOwner ? failures[activeOwner] : null),
    lightbox: (
      <>
        {opening.lightbox}
        {published.lightbox}
      </>
    ),
  };
}
