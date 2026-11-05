import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { type CloudReplyIdentity, type CloudReplyState, isCompletedCloudReply } from './cloud-reply-state';

/** Reuse dot's existing owner-only event read; its reply id must also be visible and usable. */
export async function readDotCloudReply(
  identity: CloudReplyIdentity,
  threadId: string,
  messages: readonly ChatMessage[],
  signal: AbortSignal,
): Promise<CloudReplyState> {
  if (!identity.hostMessageId || !/^dot_evt_[a-f0-9]{64}$/.test(identity.hostMessageId)) return { state: 'unverified' };
  const response = await apiFetch(`/api/plugins/chatgpt-dot/delivery/${identity.hostMessageId}`, { signal });
  if (!response.ok) return { state: 'unverified' };
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== 'object' ||
    !('threadId' in body) ||
    body.threadId !== threadId ||
    !('stale' in body) ||
    body.stale !== false ||
    !('replyMessageId' in body) ||
    typeof body.replyMessageId !== 'string'
  )
    return { state: 'unverified' };
  const answer = messages.find((m) => m.id === body.replyMessageId);
  // The existing dot read does not expose message visibility. A paged-out reply remains
  // unverified until the canonical transcript loads it; absence is never a failed delivery.
  return answer &&
    answer.replyTo === identity.sourceMessageId &&
    answer.catId === identity.targetCatId &&
    isCompletedCloudReply(answer, identity.targetCatId) &&
    answer.extra?.cloudBridgeReturn === undefined
    ? { state: 'replied', replyMessageId: answer.id }
    : { state: 'unverified' };
}
