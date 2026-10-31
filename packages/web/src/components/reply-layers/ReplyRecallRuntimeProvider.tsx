'use client';

import { type ReactNode, useMemo } from 'react';
import { useThreadRecall } from '@/hooks/useRecallEvents';
import type { ChatMessage } from '@/stores/chat-types';
import { ReplyRecallProjectionProvider } from './ReplyRecallContext';
import { buildReplyRecallProjections, type ReplyRecallReadState } from './reply-recall';

export function ReplyRecallRuntimeProvider({
  threadId,
  messages,
  children,
  enabled,
}: {
  threadId: string;
  messages: readonly ChatMessage[];
  children: ReactNode;
  enabled: boolean;
}) {
  // Keep the provider mounted across shell switches; an empty thread disables reads in classic.
  const recall = useThreadRecall({ threadId: enabled ? threadId : '', messages: enabled ? messages : [] });
  const status: ReplyRecallReadState =
    recall.historyStatus === 'loading' || recall.cuesLoading
      ? 'loading'
      : recall.historyStatus === 'error' || recall.cuesFailed
        ? 'unavailable'
        : 'ready';
  const value = useMemo(
    () => (enabled ? buildReplyRecallProjections({ messages, events: recall.events, status }) : new Map()),
    [enabled, messages, recall.events, status],
  );
  return <ReplyRecallProjectionProvider value={value}>{children}</ReplyRecallProjectionProvider>;
}
