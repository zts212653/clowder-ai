import { useChatStore } from '@/stores/chatStore';

/**
 * A send notice names the attempt that produced it, so the same attempt can take
 * its own notice back. One id rule for every producer and every settler; when
 * publishing and settling drifted apart, a reply could be visible while its
 * "please retry" line stayed behind.
 */
export function sendErrorNoticeId(attemptId: string): string {
  return `err-send-${attemptId}`;
}

/**
 * The server holds this attempt after all, so its failure notice no longer
 * describes the conversation. Two timelines arrive here:
 *
 * - a retry under the same attempt key, proven by its own response;
 * - a late commit, where the browser had already abandoned its request — no
 *   response will ever arrive, and only a live projection carries the proof.
 *
 * Both project the attempt key as `clientMessageId` (Queue entry and delivered
 * user message), so the settlement needs no identity the client does not
 * already hold. A different attempt's notice is a separate failure and stays,
 * so a real failure still shows. An event without an attempt key settles
 * nothing: guessing which draft a notice belonged to could clear a real one.
 *
 * Returns whether a notice was actually removed.
 */
export function settleSendErrorNotice(threadId: string, attemptId: string | null | undefined): boolean {
  if (!attemptId) return false;
  const id = sendErrorNoticeId(attemptId);
  const store = useChatStore.getState();
  if (!store.getThreadState(threadId).messages.some((row) => row.id === id)) return false;
  store.removeThreadMessage(threadId, id);
  // Removing records a tombstone so a late server row cannot resurrect the id.
  // A client-only notice is never published by the server, and the same attempt
  // may legitimately fail again later, so the tombstone goes too.
  store.clearThreadMessageDeletion(threadId, id);
  return true;
}

/** Settle every admitted attempt named by a live projection's attempt keys. */
export function settleAdmittedSendNotices(
  threadId: string,
  attemptIds: Iterable<string | null | undefined>,
): number {
  let settled = 0;
  for (const attemptId of attemptIds) if (settleSendErrorNotice(threadId, attemptId)) settled += 1;
  return settled;
}