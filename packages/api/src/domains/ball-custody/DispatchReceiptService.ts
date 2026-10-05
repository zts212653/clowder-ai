import type { CatId, QueueDispatchDispositionEvidenceRef, QueueTargetOutcome } from '@cat-cafe/shared';
import type { InvocationQueue, QueueEntry } from '../cats/services/agents/invocation/InvocationQueue.js';
import {
  projectUnconsumedQueueCarrier,
  readQueueCarrierMessages,
} from '../cats/services/agents/invocation/QueueCarrierSourceProjection.js';
import { carrierEntryId } from '../cats/services/agents/invocation/QueuedMessageCustodyCarrierProjection.js';
import type { QueuedMessageCustodyCoordinator } from '../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { isDispatchSource } from '../cats/services/agents/invocation/queue-source-completion-policy.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import { handedEventSourceId } from './ball-custody-events.js';
import { findDispatchTerminal } from './dispatch-terminal.js';

export interface DispatchReceiptIdentity {
  threadId: string;
  catId: string;
  sourceMessageId: string;
}

export interface SettledDispatchReceipt extends DispatchReceiptIdentity {
  ownerId: string;
}

function matchesTerminal(
  outcome: QueueTargetOutcome | undefined,
  expected: QueueDispatchDispositionEvidenceRef,
): boolean {
  const actual = outcome?.evidenceRef;
  return (
    outcome?.disposition === 'dispatch_disposition' &&
    outcome.invocationId === expected.invocationId &&
    actual?.kind === 'dispatch_disposition' &&
    actual.invocationId === expected.invocationId &&
    actual.sourceMessageId === expected.sourceMessageId &&
    actual.handoffEventId === expected.handoffEventId &&
    actual.dispositionEventId === expected.dispositionEventId &&
    actual.disposition === expected.disposition &&
    actual.dispositionAt === expected.dispositionAt
  );
}

interface DispatchReceiptDeps {
  messageStore: IMessageStore;
  queue: Pick<
    InvocationQueue,
    'getEntrySnapshot' | 'removeEntrySnapshotIfUnchanged' | 'restoreEntrySnapshotIfUnchanged'
  >;
  coordinator: Pick<
    QueuedMessageCustodyCoordinator,
    'commitSuccessfulTargetsForMessages' | 'commitSuccessfulTargetForMessage'
  >;
  eventLog: Pick<IBallCustodyEventLog, 'read'>;
  onSettled?(input: SettledDispatchReceipt): void | Promise<void>;
}

/** Projects a durable dispatch terminal onto its existing source custody. No second work ledger. */
export class DispatchReceiptService {
  constructor(private readonly deps: DispatchReceiptDeps) {}

  async repairSource(messageId: string): Promise<void> {
    const source = await this.deps.messageStore.getById(messageId);
    if (!source?.queueCustody) return;
    const targets = new Set(source.queueCustody.bodyExposures?.map((witness) => witness.targetCatId));
    for (const catId of targets) {
      if (isDispatchSource(source, catId))
        await this.repair({ threadId: source.threadId, catId, sourceMessageId: messageId });
    }
  }

  async repairInvocation(input: { threadId: string; catId: string; invocationId: string }): Promise<void> {
    const messages = await this.deps.messageStore.getByQueueExposure(input.threadId, input.catId, input.invocationId);
    for (const message of messages) {
      if (
        isDispatchSource(message, input.catId) &&
        message.queueCustody?.bodyExposures?.some(
          (item) => item.targetCatId === input.catId && item.invocationId === input.invocationId,
        )
      ) {
        await this.repair({ ...input, sourceMessageId: message.id });
      }
    }
  }

  async repair(input: DispatchReceiptIdentity): Promise<boolean> {
    const message = await this.deps.messageStore.getById(input.sourceMessageId);
    const custody = message?.queueCustody;
    if (
      !message ||
      message.threadId !== input.threadId ||
      !message.catId ||
      !custody ||
      !custody.allTargetCats.includes(input.catId as CatId)
    )
      throw new Error('Dispatch receipt source mismatch');
    const terminal = findDispatchTerminal(await this.deps.eventLog.read(`ball:thread:${input.threadId}`), {
      ...input,
      fromCatId: message.catId,
    });
    // Ordinary complete() owns its own Queue settlement. A previous Live read
    // does not turn that later ordinary terminal into an adopted receipt.
    if (!terminal || terminal.payload.adopted === undefined) return false;
    const invocationId = terminal.payload.invocationId;
    const exposure = custody.bodyExposures?.find(
      (item) => item.targetCatId === input.catId && item.invocationId === invocationId,
    );
    if (!exposure) throw new Error('Dispatch receipt requires its original invocation exposure');
    const ownerId = custody.ownerUserId ?? message.userId;
    const physicalId = carrierEntryId(custody, input.catId) ?? custody.entryId;
    const entry = this.deps.queue.getEntrySnapshot(input.threadId, ownerId, physicalId);
    const existing = custody.targetOutcomeByCatId?.[input.catId];
    const evidenceRef: QueueDispatchDispositionEvidenceRef = {
      kind: 'dispatch_disposition',
      invocationId,
      sourceMessageId: message.id,
      handoffEventId: handedEventSourceId(message.id, input.catId),
      dispositionEventId: terminal.sourceEventId,
      disposition: terminal.payload.disposition,
      dispositionAt: terminal.at,
    };
    if (custody.handledByCatIds.includes(input.catId as CatId)) {
      if (!matchesTerminal(existing, evidenceRef)) {
        throw new Error('Dispatch receipt conflicts with an existing outcome');
      }
    } else {
      const handledAt = Math.max(Date.now(), terminal.at, exposure.seenAt + 1);
      const outcome: QueueTargetOutcome = {
        invocationId,
        disposition: 'dispatch_disposition',
        handledAt,
        evidenceRef,
      };
      if (entry?.targetCats.includes(input.catId)) {
        await this.deps.coordinator.commitSuccessfulTargetsForMessages(
          entry,
          [message.id],
          [input.catId],
          invocationId,
          handledAt,
          { [message.id]: { [input.catId]: outcome } },
        );
      } else {
        await this.deps.coordinator.commitSuccessfulTargetForMessage(
          custody.entryId,
          message.id,
          input.catId,
          invocationId,
          handledAt,
          outcome,
          () =>
            !this.deps.queue.getEntrySnapshot(input.threadId, ownerId, physicalId)?.targetCats.includes(input.catId),
        );
      }
      const settled = await this.deps.messageStore.getById(message.id);
      const committed = settled?.queueCustody?.targetOutcomeByCatId?.[input.catId];
      if (!matchesTerminal(committed, evidenceRef)) {
        throw new Error('Dispatch receipt did not commit its exact terminal');
      }
    }
    if (entry) await this.pruneCarrier(entry);
    await this.deps.onSettled?.({ ...input, ownerId });
    return true;
  }

  private async pruneCarrier(entry: QueueEntry): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.deps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
      if (!current) return;
      const messages = await readQueueCarrierMessages(current, this.deps.messageStore);
      const remaining = projectUnconsumedQueueCarrier(current, messages);
      const changed =
        remaining === null
          ? this.deps.queue.removeEntrySnapshotIfUnchanged(current)
          : this.deps.queue.restoreEntrySnapshotIfUnchanged(current, remaining);
      if (changed) return;
    }
    throw new Error('Dispatch receipt committed; Queue projection needs retry');
  }
}
