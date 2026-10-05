import type { IBallCustodyEventLog } from '../../../../ball-custody/BallCustodyEventLog.js';
import { handedEventSourceId } from '../../../../ball-custody/ball-custody-events.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { QueueReadEvidenceWitness } from '../../stores/ports/queued-message-custody.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import { isDispatchSource } from './queue-source-completion-policy.js';

interface FullReadInput {
  threadId: string;
  userId: string;
  catId: string;
  invocationId: string;
  messageIds: readonly string[];
  seenAt: number;
}

/** Called only at the full-contiguous response boundary, after visibility and body-budget filtering. */
export async function recordLiveFullReadEvidence(
  messages: IMessageStore,
  executions: Pick<ITurnExecutionStore, 'get'>,
  input: FullReadInput,
  eventLog?: Pick<IBallCustodyEventLog, 'read'>,
): Promise<void> {
  if (!eventLog) return;
  const child = await executions.get(input.invocationId);
  if (child?.queueCompletionPolicy !== 'explicit_source') return;
  if (
    child.status !== 'running' ||
    child.threadId !== input.threadId ||
    child.userId !== input.userId ||
    child.catId !== input.catId
  ) {
    throw new Error('Live full-read execution is no longer active in this scope');
  }
  const witness: QueueReadEvidenceWitness = {
    targetCatId: input.catId,
    invocationId: input.invocationId,
    seenAt: input.seenAt,
    evidenceKind: 'full_contiguous_thread_context',
  };
  const events = await eventLog.read(`ball:thread:${input.threadId}`);
  for (const messageId of new Set(input.messageIds)) {
    const handoffEventId = handedEventSourceId(messageId, input.catId);
    const handoff = events.find(
      (event) =>
        event.kind === 'ball.handed' && event.sourceEventId === handoffEventId && event.payload.toCatId === input.catId,
    );
    if (!handoff || !Number.isFinite(handoff.at) || input.seenAt <= handoff.at) continue;
    await recordMessageReadEvidence(messages, messageId, input, { ...witness, handoffEventId }, handoff.at);
  }
}

async function recordMessageReadEvidence(
  messages: IMessageStore,
  messageId: string,
  input: FullReadInput,
  witness: QueueReadEvidenceWitness,
  handoffAt: number,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const message = await messages.getById(messageId);
    const custody = message?.queueCustody;
    if (
      !message ||
      !isDispatchSource(message, input.catId) ||
      message.threadId !== input.threadId ||
      !custody ||
      custody.status === 'terminal' ||
      message.deliveryStatus !== 'queued' ||
      (custody.ownerUserId ?? message.userId) !== input.userId
    )
      return;
    const exposure = custody.bodyExposures?.find(
      (item) => item.targetCatId === input.catId && item.invocationId === input.invocationId,
    );
    if (!exposure) return;
    const existing = custody.readEvidenceWitnesses ?? [];
    if (
      existing.some(
        (item) =>
          item.targetCatId === input.catId &&
          item.invocationId === input.invocationId &&
          item.seenAt > handoffAt &&
          (item.handoffEventId ?? witness.handoffEventId) === witness.handoffEventId &&
          item.evidenceKind === witness.evidenceKind,
      )
    )
      return;
    const result = await messages.transitionQueueCustody(messageId, {
      expectedRevision: custody.revision,
      next: {
        ...custody,
        revision: custody.revision + 1,
        readEvidenceWitnesses: [...existing, witness],
        updatedAt: Math.max(input.seenAt, custody.updatedAt),
      },
    });
    if (result.kind === 'updated') return;
    if (result.kind !== 'revision_mismatch' || attempt === 2)
      throw new Error('Live full-read evidence could not be committed');
  }
}

/** The enclosing message is the source identity; no Queue coalescing alias can replace it. */
export async function getQueueReadEvidence(
  messages: Pick<IMessageStore, 'getById'>,
  query: { threadId: string; catId: string; invocationId: string; messageId: string },
): Promise<{ messageId: string; seenAt: number; evidenceKind: string } | null> {
  const message = await messages.getById(query.messageId);
  if (!message || message.threadId !== query.threadId) return null;
  const witness = message.queueCustody?.readEvidenceWitnesses
    ?.filter(
      (item) =>
        item.targetCatId === query.catId &&
        item.invocationId === query.invocationId &&
        (item.handoffEventId === undefined ||
          item.handoffEventId === handedEventSourceId(query.messageId, query.catId)),
    )
    .sort((a, b) => b.seenAt - a.seenAt)[0];
  return witness ? { messageId: message.id, seenAt: witness.seenAt, evidenceKind: witness.evidenceKind } : null;
}
