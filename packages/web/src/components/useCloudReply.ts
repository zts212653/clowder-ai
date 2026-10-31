'use client';

import { isCloudBridgeReturnV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import {
  type CloudReplyIdentity,
  type CloudReplyState,
  cloudReplyCandidates,
  projectCloudReply,
} from './cloud-reply-state';
import { readDotCloudReply } from './read-dot-cloud-reply';

const EMPTY: readonly ChatMessage[] = [];
/** A bounded owner read restores reply provenance outside the currently loaded history page. */
export function useCloudReply(
  identity: CloudReplyIdentity | undefined,
  threadId?: string,
  messages = EMPTY,
  { readDotEvent = false }: { readDotEvent?: boolean } = {},
): CloudReplyState {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const local =
    identity && threadId ? projectCloudReply(identity, threadId, messages) : { state: 'unverified' as const };
  const candidates = identity ? cloudReplyCandidates(identity, messages) : [];
  const owner = identity ? getUserId() : undefined;
  const sourceMessageId = identity?.sourceMessageId;
  const targetCatId = identity?.targetCatId;
  const dispatchInvocationId = identity?.dispatchInvocationId;
  const hostMessageId = identity?.hostMessageId;
  const source = messages.find((m) => m.id === identity?.sourceMessageId);
  const sourceHidden = Boolean(source?.extra?.recall || source?.visibility === 'whisper');
  const knownReplyId = local.state === 'source_replied' ? local.replyMessageId : undefined;
  const key = JSON.stringify([
    owner,
    threadId,
    sourceMessageId,
    targetCatId,
    dispatchInvocationId,
    hostMessageId,
    readDotEvent,
    sourceHidden,
    candidates.map((m) => [
      m.id,
      m.content,
      m.isStreaming,
      m.extra?.recall,
      m.visibility,
      m.extra?.cloudBridgeReturn,
      m.lifecycle,
    ]),
  ]);
  const [remote, setRemote] = useState<{ key: string; result: CloudReplyState } | null>(null);
  useEffect(() => {
    if (
      !sourceMessageId ||
      !targetCatId ||
      !dispatchInvocationId ||
      !threadId ||
      (targetCatId === 'gpt-dot' && !readDotEvent) ||
      local.state === 'replied' ||
      sourceHidden
    )
      return;
    const controller = new AbortController();
    if (targetCatId === 'gpt-dot') {
      if (!hostMessageId || !/^dot_evt_[a-f0-9]{64}$/.test(hostMessageId)) return;
      const read = async () => {
        try {
          const result = await readDotCloudReply(
            { sourceMessageId, targetCatId, dispatchInvocationId, hostMessageId },
            threadId,
            messagesRef.current,
            controller.signal,
          );
          if (controller.signal.aborted || owner !== getUserId()) return;
          setRemote({ key, result });
          if (result.state === 'replied') clearInterval(timer);
        } catch {
          /* An unavailable read never proves no reply. */
        }
      };
      const timer = setInterval(() => void read(), 5000);
      void read();
      return () => {
        controller.abort();
        clearInterval(timer);
      };
    }
    const query = new URLSearchParams({ targetCatId, dispatchInvocationId });
    if (knownReplyId) query.set('replyMessageId', knownReplyId);
    void apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(sourceMessageId)}/cloud-return?${query}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ status?: string; replyMessageId?: string; proof?: unknown }>;
      })
      .then((body) => {
        if (controller.signal.aborted || owner !== getUserId()) return;
        const proof = body?.proof;
        const replyMessageId = body?.replyMessageId;
        const matched =
          body?.status === 'matched' &&
          typeof replyMessageId === 'string' &&
          replyMessageId &&
          isCloudBridgeReturnV1(proof) &&
          proof.threadId === threadId &&
          proof.sourceMessageId === sourceMessageId &&
          proof.targetCatId === targetCatId &&
          proof.dispatchInvocationId === dispatchInvocationId;
        setRemote({
          key,
          result:
            matched && replyMessageId
              ? { state: 'replied', replyMessageId }
              : body?.status === 'source_replied' &&
                  typeof replyMessageId === 'string' &&
                  replyMessageId.length > 0 &&
                  replyMessageId.length <= 512
                ? { state: 'source_replied', replyMessageId }
                : { state: 'unverified' },
        });
      })
      .catch(() => {});
    return () => controller.abort();
    // key includes every source/answer/owner boundary; unrelated timeline rows do not refetch.
  }, [
    key,
    local.state,
    sourceMessageId,
    targetCatId,
    dispatchInvocationId,
    hostMessageId,
    readDotEvent,
    threadId,
    owner,
    sourceHidden,
    knownReplyId,
  ]);
  return local.state === 'replied'
    ? local
    : remote?.key === key && remote.result.state === 'replied'
      ? remote.result
      : local.state === 'source_replied'
        ? local
        : remote?.key === key
          ? remote.result
          : local;
}
