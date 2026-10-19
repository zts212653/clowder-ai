'use client';

import {
  type MessageMediaItemSelector,
  type MessageMediaPublicationSource,
  messageMediaItemKey,
  workspaceContentLocatorSchema,
} from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { FileData } from '@/hooks/useWorkspace';
import { inferFileKind } from '@/lib/file-kind';
import { useChatStore } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { mediaChatMime } from './media-chat-selection';
import { checked, ModificationHttpError } from './modification-http';
import {
  type ArtworkOpenResult,
  type ArtworkPresentation,
  messagePublicationSource,
  type PublishedMessageCoordinate,
  usePublishedContent,
} from './usePublishedContent';

type WorkspaceArtworkEntry = { kind: 'workspace'; worktreeId: string; path: string; messageId?: string };
type ArtworkEntry = MessageMediaPublicationSource | WorkspaceArtworkEntry;

/** URL coordinates are only a candidate: the existing authenticated file owner still admits the read. */
export function workspaceArtworkEntry(raw: string): WorkspaceArtworkEntry | null {
  try {
    const apiOrigin = new URL(API_URL).origin;
    const url = new URL(raw, apiOrigin);
    if (url.origin !== apiOrigin && url.origin !== window.location.origin) return null;
    if (url.pathname !== '/api/workspace/file/raw') return null;
    if (url.searchParams.getAll('worktreeId').length !== 1 || url.searchParams.getAll('path').length !== 1) return null;
    const candidate = {
      worktreeId: url.searchParams.get('worktreeId'),
      path: url.searchParams.get('path'),
    };
    const locator = workspaceContentLocatorSchema.safeParse(candidate);
    // A schema trim must never redirect a native filename to a different file.
    if (locator.success && (locator.data.worktreeId !== candidate.worktreeId || locator.data.path !== candidate.path))
      return null;
    // The raw route also serves audio. Only image/video paths belong to this artwork entry.
    if (
      locator.success &&
      inferFileKind(locator.data.path) !== 'image' &&
      !/\.(mp4|webm|mov)$/i.test(locator.data.path)
    )
      return null;
    return locator.success ? { kind: 'workspace', ...locator.data } : null;
  } catch {
    return null;
  }
}

export function useChatArtworkEntry(publication?: PublishedMessageCoordinate) {
  const isV2 = useShellPresentation() === 'v2';
  const published = usePublishedContent();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const source = (url: string, item: MessageMediaItemSelector, coordinate = publication): ArtworkEntry | null => {
    const workspace = isV2 ? workspaceArtworkEntry(url) : null;
    return workspace
      ? {
          ...workspace,
          messageId: coordinate?.origins?.[messageMediaItemKey(item)]?.messageId ?? coordinate?.messageId,
        }
      : messagePublicationSource(coordinate, item, url);
  };

  const open = async (
    entry: ArtworkEntry | null,
    title: string,
    presentation: ArtworkPresentation = 'workspace',
    isCurrent: () => boolean = () => true,
  ): Promise<ArtworkOpenResult> => {
    setError(null);
    published.clearError();
    if (!entry) return { status: 'preview', reason: '无法批注：这张媒体没有可定位的工作区文件或已发布作品。' };
    if (entry.kind === 'message') return published.open(entry, title, presentation, isCurrent);
    if (pending.current && presentation === 'workspace') return { status: 'blocked' };
    pending.current = true;
    const ticket = ++generation.current;
    const hostThreadId = useChatStore.getState().currentThreadId;
    setBusy(true);
    setError(null);
    try {
      const { worktreeId, path } = entry;
      const file = await checked<FileData>(
        await apiFetch(`/api/workspace/file?${new URLSearchParams({ worktreeId, path })}`),
      );
      if (ticket !== generation.current) return { status: 'blocked' };
      if (useChatStore.getState().currentThreadId !== hostThreadId) {
        setError('对话已切换。回到来源后可以继续打开这件作品。');
        return { status: 'blocked' };
      }
      if (!isCurrent()) return { status: 'blocked' };
      if (file.path !== path) throw new Error('返回的文件位置与原作品不一致。');
      const target = {
        kind: 'file' as const,
        worktreeId,
        path,
        ...(publication
          ? {
              navigationOrigin: {
                kind: 'chat-file-link' as const,
                threadId: publication.threadId,
                messageId: entry.messageId ?? publication.messageId,
              },
            }
          : {}),
      };
      if (
        !mediaChatMime(file.mime ?? '') &&
        !(presentation === 'work-mode' && /^(image|video)\//.test(file.mime ?? ''))
      )
        return {
          status: 'preview',
          reason: '无法批注：这份文件的格式尚不支持。',
          ...(/^(image|video)\//.test(file.mime ?? '') ? { target } : {}),
        };
      if (presentation === 'work-mode') captureChatReadingBeforeLayoutChange();
      const applied =
        presentation === 'lightbox' ||
        (presentation === 'work-mode'
          ? useChatStore.getState().openWorkspacePath(hostThreadId, target, 'work-mode')
          : useChatStore.getState().openWorkspacePath(hostThreadId, target));
      return applied ? { status: 'opened', target } : { status: 'blocked' };
    } catch (failure) {
      if (ticket !== generation.current || !isCurrent() || useChatStore.getState().currentThreadId !== hostThreadId)
        return { status: 'blocked' };
      const reason = failure instanceof Error ? failure.message : '暂时无法读取原作品。';
      setError(reason);
      return failure instanceof ModificationHttpError && [401, 403].includes(failure.status)
        ? { status: 'blocked' }
        : { status: 'preview', reason: `无法批注：${reason}` };
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    isV2,
    busy: busy || published.busy,
    error: error ?? published.error,
    source,
    open,
    versionFor: (entry: ArtworkEntry | null) => (entry?.kind === 'message' ? published.versionFor(entry) : undefined),
  };
}
