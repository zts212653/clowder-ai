'use client';

import {
  type MessageMediaItemSelector,
  type MessageMediaPublicationSource,
  messageMediaItemKey,
  messagePublicationLandingSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessagePublicationOrigin, WorkspaceOpenRequest } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import type { MessageArtworkItem } from './message-artwork-gallery';
import { checked, json, ModificationHttpError } from './modification-http';

export type ArtworkTarget = Extract<
  WorkspaceOpenRequest['target'],
  { kind: 'file' | 'publication' | 'message-publication' }
>;
export type ArtworkPresentation = 'workspace' | 'lightbox' | 'work-mode';
export type ArtworkOpenResult =
  | { status: 'opened'; target: ArtworkTarget }
  | { status: 'blocked' }
  | { status: 'preview'; reason: string; target?: ArtworkTarget };

export interface PublishedMessageCoordinate {
  threadId: string;
  messageId: string;
  messageRevision: string;
  origins?: Record<string, MessagePublicationOrigin>;
  media?: readonly MessageArtworkItem[];
}
export function messagePublicationSource(
  coordinate: PublishedMessageCoordinate | undefined,
  item: MessageMediaItemSelector,
  url: string,
): MessageMediaPublicationSource | null {
  const uploaded = /^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp|mp4)$/i.test(url);
  const dotImage = /^\/api\/plugins\/chatgpt-dot\/images\/dot_img_[a-f0-9]{64}\.png$/.test(url);
  if (!coordinate || (!uploaded && !dotImage)) return null;
  const original = coordinate.origins?.[messageMediaItemKey(item)] ?? {
    messageId: coordinate.messageId,
    messageRevision: coordinate.messageRevision,
    item,
  };
  return {
    kind: 'message',
    threadId: coordinate.threadId,
    messageId: original.messageId,
    messageRevision: original.messageRevision,
    item: original.item,
    expectedUrl: url,
  };
}

/** Resolves the immutable owner before opening; the host only receives a verified coordinate. */
export function usePublishedContent() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openedVersion, setOpenedVersion] = useState<{ source: string; revision: number } | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const open = useCallback(
    async (
      source: MessageMediaPublicationSource,
      title: string,
      presentation: ArtworkPresentation = 'workspace',
      isCurrent: () => boolean = () => true,
    ): Promise<ArtworkOpenResult> => {
      if (pending.current && presentation === 'workspace') return { status: 'blocked' };
      const ticket = ++generation.current;
      const hostThreadId = useChatStore.getState().currentThreadId;
      pending.current = true;
      setBusy(true);
      setError(null);
      try {
        const landing = messagePublicationLandingSchema.parse(
          await checked<unknown>(
            await apiFetch('/api/content-publications/resolve', json({ source, operationId: crypto.randomUUID() })),
          ),
        );
        if (ticket !== generation.current) return { status: 'blocked' };
        if (useChatStore.getState().currentThreadId !== hostThreadId) {
          setError('对话已切换。回到来源后可以继续打开这件作品。');
          return { status: 'blocked' };
        }
        if (!isCurrent()) return { status: 'blocked' };
        let changedSelection = false;
        try {
          const saved = localStorage.getItem(
            `cat-cafe:message-publication:${landing.ownerUserId}:${JSON.stringify(source)}`,
          );
          changedSelection =
            !!saved &&
            landing.status === 'resolved' &&
            saved !==
              JSON.stringify({ contentRef: landing.asset.contentRef, ownerRevision: landing.asset.ownerRevision });
        } catch {
          /* Resolving the owner does not require browser storage. */
        }
        const target = {
          ...(landing.status === 'resolved' && !changedSelection
            ? {
                kind: 'publication' as const,
                contentRef: landing.asset.contentRef,
                ownerRevision: landing.asset.ownerRevision,
                messagePublicationSource: source,
              }
            : { kind: 'message-publication' as const, source }),
          title,
          navigationOrigin: { kind: 'chat-file-link' as const, threadId: source.threadId, messageId: source.messageId },
        };
        // The same owner resolves both presentations. Only the explicit Workspace action changes navigation.
        if (presentation === 'work-mode') captureChatReadingBeforeLayoutChange();
        const applied =
          presentation === 'lightbox' ||
          (presentation === 'work-mode'
            ? useChatStore.getState().openPublication(target, hostThreadId, 'work-mode')
            : useChatStore.getState().openPublication(target, hostThreadId));
        if (!applied) setError('对话已切换。回到来源后可以继续打开这件作品。');
        if (applied && landing.status === 'resolved')
          setOpenedVersion({ source: JSON.stringify(source), revision: landing.asset.ownerRevision });
        return applied ? { status: 'opened', target } : { status: 'blocked' };
      } catch (failure) {
        if (ticket !== generation.current || !isCurrent() || useChatStore.getState().currentThreadId !== hostThreadId)
          return { status: 'blocked' };
        const reason = failure instanceof Error ? failure.message : '作品暂时无法打开，请重试。';
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
    },
    [],
  );
  return {
    busy,
    error,
    open,
    clearError: () => setError(null),
    versionFor: (source: MessageMediaPublicationSource) =>
      openedVersion?.source === JSON.stringify(source) ? openedVersion.revision : undefined,
  };
}
