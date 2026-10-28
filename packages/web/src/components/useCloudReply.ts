'use client';

import { isCloudBridgeReturnV1 } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import {
  type CloudReplyIdentity,
  type CloudReplyState,
  cloudReplyCandidates,
  projectCloudReply,
} from './cloud-reply-state';

const EMPTY: readonly ChatMessage[] = [];
/** A bounded owner read restores reply provenance outside the currently loaded history page. */
export function useCloudReply(
  identity: CloudReplyIdentity | undefined,
  threadId?: string,
  messages = EMPTY,
): CloudReplyState {
  const local =
    identity && threadId ? projectCloudReply(identity, threadId, messages) : { state: 'unverified' as const };
  const candidates = identity ? cloudReplyCandidates(identity, messages) : [];
  const owner = getUserId();
  const sourceMessageId = identity?.sourceMessageId;
  const targetCatId = identity?.targetCatId;
  const dispatchInvocationId = identity?.dispatchInvocationId;
  const source = messages.find((m) => m.id === identity?.sourceMessageId);
  const sourceHidden = Boolean(source?.extra?.recall || source?.visibility === 'whisper');
  const knownReplyId = local.state === 'source_replied' ? local.replyMessageId : undefined;
  const key = JSON.stringify([
    owner,
    threadId,
    sourceMessageId,
    targetCatId,
    dispatchInvocationId,
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
      targetCatId === 'gpt-dot' ||
      local.state === 'replied' ||
      sourceHidden
    )
      return;
    const controller = new AbortController();
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
