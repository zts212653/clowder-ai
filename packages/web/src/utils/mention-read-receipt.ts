/** A durable read receipt dirties the existing mention reader only when it closed actual mentions. */
export function notifyHandledMentionRead(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const receipt = body as Record<string, unknown>;
  const count = receipt.handledMentionCount;
  if (receipt.handledMention !== true && !(typeof count === 'number' && Number.isSafeInteger(count) && count > 0))
    return;
  window.dispatchEvent(new Event('cat-cafe:user-mention-updated'));
}
