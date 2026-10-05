'use client';

import {
  type MessageMediaItemSelector,
  type MessageMediaPublicationSource,
  messageMediaItemKey,
  messagePublicationLandingSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessagePublicationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { checked, json } from './modification-http';

export interface PublishedMessageCoordinate {
  threadId: string;
  messageId: string;
  messageRevision: string;
  origins?: Record<string, MessagePublicationOrigin>;
}
export function messagePublicationSource(
  coordinate: PublishedMessageCoordinate | undefined,
  item: MessageMediaItemSelector,
  url: string,
): MessageMediaPublicationSource | null {
  if (!coordinate || !/^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|mp4)$/i.test(url)) return null;
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
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const open = useCallback(async (source: MessageMediaPublicationSource, title: string) => {
    if (pending.current) return;
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
      if (ticket !== generation.current) return;
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
      const applied = useChatStore.getState().openPublication(
        {
          ...(landing.status === 'resolved' && !changedSelection
            ? {
                kind: 'publication' as const,
                contentRef: landing.asset.contentRef,
                ownerRevision: landing.asset.ownerRevision,
                messagePublicationSource: source,
              }
            : { kind: 'message-publication' as const, source }),
          title,
          navigationOrigin: { kind: 'chat-file-link', threadId: source.threadId, messageId: source.messageId },
        },
        hostThreadId,
      );
      if (!applied) setError('对话已切换。回到来源后可以继续打开这件作品。');
    } catch (failure) {
      if (ticket === generation.current)
        setError(failure instanceof Error ? failure.message : '作品暂时无法打开，请重试。');
    } finally {
      pending.current = false;
      if (ticket === generation.current) setBusy(false);
    }
  }, []);
  return { busy, error, open };
}
