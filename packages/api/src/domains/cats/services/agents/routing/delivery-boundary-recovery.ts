import type { CatId } from '@cat-cafe/shared';
import { type CanonicalVisibilityCursor, compareCursors, cursorFor, parseCursor } from '../../stores/cursor.js';
import { type MessageDeliveryBoundary, parseMessageDeliveryBoundary } from '../../stores/message-delivery-boundary.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, isOwnerVisibleManagedHoldConnector } from '../../stores/visibility.js';

interface Target {
  userId: string;
  threadId: string;
  catId: CatId;
}

function isAvailable(message: StoredMessage): boolean {
  return !message.deletedAt && !message._tombstone && !message.recall && message.deliveryStatus !== 'canceled';
}

function belongsToSource(source: StoredMessage, target: Target): boolean {
  return (
    source.threadId === target.threadId &&
    isAvailable(source) &&
    (source.userId === target.userId || isOwnerVisibleManagedHoldConnector(source, target.userId)) &&
    canViewMessage(source, { type: 'cat', catId: target.catId })
  );
}

function isOwnReply(reply: StoredMessage, target: Target): boolean {
  return (
    reply.userId === target.userId &&
    reply.threadId === target.threadId &&
    reply.catId === target.catId &&
    (reply.origin === 'stream' || reply.origin === 'callback') &&
    isAvailable(reply) &&
    canViewMessage(reply, { type: 'cat', catId: target.catId }) &&
    typeof reply.extra?.stream?.turnInvocationId === 'string' &&
    reply.extra.stream.turnInvocationId.length > 0 &&
    reply.extra?.causal?.kind === 'invocation_reply' &&
    (!reply.extra.turnExecution || reply.extra.turnExecution.invocationId === reply.extra.stream.turnInvocationId)
  );
}

function verifiedDeliveryProof(
  reply: StoredMessage,
  index: ReadonlyMap<string, StoredMessage>,
  target: Target,
): MessageDeliveryBoundary | undefined {
  if (!isOwnReply(reply, target)) return undefined;
  const proof = parseMessageDeliveryBoundary(reply.extra?.deliveryBoundary);
  if (
    !proof ||
    proof.userId !== target.userId ||
    proof.threadId !== target.threadId ||
    proof.catId !== target.catId ||
    proof.turnInvocationId !== reply.extra?.stream?.turnInvocationId ||
    proof.sourceMessageId !== reply.extra?.causal?.triggerMessageId
  )
    return undefined;
  const source = index.get(proof.sourceMessageId);
  const boundaryId = parseCursor(proof.cursor)?.id;
  const boundary = boundaryId ? index.get(boundaryId) : undefined;
  if (
    !source ||
    !belongsToSource(source, target) ||
    !boundary ||
    boundary.threadId !== target.threadId ||
    boundary.visibilitySeq === undefined ||
    reply.visibilitySeq === undefined ||
    source.visibilitySeq === undefined ||
    cursorFor(boundary) !== proof.cursor ||
    compareCursors(proof.cursor, cursorFor(reply)) >= 0 ||
    compareCursors(cursorFor(source), cursorFor(reply)) >= 0
  )
    return undefined;
  return proof;
}

/** Uses the already fetched visibility window. Never scans history or promotes seen/source time. */
export function recoverableDeliveryBoundary(
  messages: readonly StoredMessage[],
  target: Target,
): { cursor?: CanonicalVisibilityCursor; answeredSourceIds: ReadonlySet<string> } {
  const index = new Map(messages.map((message) => [message.id, message]));
  const answeredSourceIds = new Set<string>();
  let cursor: CanonicalVisibilityCursor | undefined;
  for (const reply of messages) {
    const proof = verifiedDeliveryProof(reply, index, target);
    if (!proof) continue;
    if (!cursor || compareCursors(proof.cursor, cursor) > 0) cursor = proof.cursor;
    if (reply.content.trim() || (reply.contentBlocks?.length ?? 0) > 0) answeredSourceIds.add(proof.sourceMessageId);
  }
  return { ...(cursor ? { cursor } : {}), answeredSourceIds };
}
