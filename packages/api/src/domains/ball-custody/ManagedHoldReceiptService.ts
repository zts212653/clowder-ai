import type { CatId, QueueTargetOutcome } from '@cat-cafe/shared';
import type { InvocationQueue, QueueEntry } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { QueuedMessageCustodyCoordinator } from '../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';

export interface ManagedHoldReceiptInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly taskId: string;
  readonly handledAt: number;
}

export interface ManagedHoldReceiptResult {
  readonly outcome: 'applied' | 'replayed';
  readonly entryId: string;
}

export class ManagedHoldReceiptError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManagedHoldReceiptError';
  }
}

interface ManagedHoldReceiptDeps {
  readonly queue: Pick<InvocationQueue, 'getEntrySnapshot' | 'removeEntrySnapshotIfUnchanged'>;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly coordinator: Pick<QueuedMessageCustodyCoordinator, 'commitSuccessfulTargetForMessage'>;
  readonly now?: () => number;
  readonly onSettled?: (input: ManagedHoldReceiptInput & { entryId: string }) => void | Promise<void>;
}

function entryMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
}

function exactOutcomeMatches(
  outcome: QueueTargetOutcome | undefined,
  invocationId: string,
): outcome is QueueTargetOutcome {
  return (
    outcome?.invocationId === invocationId &&
    outcome.evidenceRef.kind === 'invocation_lineage' &&
    outcome.evidenceRef.invocationId === invocationId
  );
}

/**
 * F264 adapter for one managed-hold Queue carrier.
 *
 * It consumes only the exact source/target exposed to this invocation. No
 * thread-wide "mark everything seen as handled" widening is permitted.
 */
export class ManagedHoldReceiptService {
  private readonly now: () => number;

  constructor(private readonly deps: ManagedHoldReceiptDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(input: ManagedHoldReceiptInput): Promise<ManagedHoldReceiptResult> {
    const message = await this.deps.messageStore.getById(input.sourceMessageId);
    const custody = message?.queueCustody;
    if (!message || message.threadId !== input.threadId || !custody) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_missing');
    }

    const sourceTaskId = message.source?.meta?.taskId;
    if (message.source?.connector !== 'hold-ball' || sourceTaskId !== input.taskId) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_source_mismatch');
    }

    const existingOutcome = custody.targetOutcomeByCatId?.[input.catId];
    if (custody.handledByCatIds.includes(input.catId as CatId)) {
      if (!exactOutcomeMatches(existingOutcome, input.invocationId)) {
        throw new ManagedHoldReceiptError('managed_hold_receipt_replay_mismatch');
      }
      await this.removeResidualCarrier(custody.entryId, input.userId, input);
      return { outcome: 'replayed', entryId: custody.entryId };
    }

    const exposure = custody.bodyExposures?.find(
      (candidate) => candidate.targetCatId === input.catId && candidate.invocationId === input.invocationId,
    );
    if (
      !custody.pendingTargetCats.includes(input.catId as CatId) ||
      custody.seenInvocationIdByCatId[input.catId] !== input.invocationId ||
      !exposure
    ) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_invocation_mismatch');
    }

    const entry = this.deps.queue.getEntrySnapshot(input.threadId, input.userId, custody.entryId);
    this.assertExactCarrier(entry, input);

    const handledAt = Math.max(input.handledAt, exposure.seenAt + 1, this.now());
    const outcome: QueueTargetOutcome = {
      invocationId: input.invocationId,
      disposition: 'managed_hold_disposition',
      evidenceRef: { kind: 'invocation_lineage', invocationId: input.invocationId },
      handledAt,
    };
    const completion = await this.deps.coordinator.commitSuccessfulTargetForMessage(
      custody.entryId,
      input.sourceMessageId,
      input.catId,
      input.invocationId,
      handledAt,
      outcome,
      () => true,
    );
    if (!completion.handledTargetCats.includes(input.catId as CatId)) {
      const after = await this.deps.messageStore.getById(input.sourceMessageId);
      if (!exactOutcomeMatches(after?.queueCustody?.targetOutcomeByCatId?.[input.catId], input.invocationId)) {
        throw new ManagedHoldReceiptError('managed_hold_receipt_commit_rejected');
      }
    }

    if (!entry || !this.deps.queue.removeEntrySnapshotIfUnchanged(entry)) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_carrier_changed');
    }
    await this.deps.onSettled?.({ ...input, entryId: custody.entryId, handledAt });
    return { outcome: 'applied', entryId: custody.entryId };
  }

  private assertExactCarrier(entry: QueueEntry | null, input: ManagedHoldReceiptInput): asserts entry is QueueEntry {
    if (
      !entry ||
      (entry.status !== 'processing' && entry.status !== 'queued') ||
      entry.threadId !== input.threadId ||
      entry.source !== 'connector' ||
      entry.sourceCategory !== 'scheduled' ||
      !entry.targetCats.includes(input.catId as CatId) ||
      entry.queuedSeenInvocationIdByCatId?.[input.catId] !== input.invocationId ||
      entryMessageIds(entry).length !== 1 ||
      entryMessageIds(entry)[0] !== input.sourceMessageId
    ) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_carrier_mismatch');
    }
  }

  private async removeResidualCarrier(
    entryId: string,
    messageUserId: string,
    input: ManagedHoldReceiptInput,
  ): Promise<void> {
    const entry = this.deps.queue.getEntrySnapshot(input.threadId, messageUserId, entryId);
    if (!entry) return;
    this.assertExactCarrier(entry, input);
    if (!this.deps.queue.removeEntrySnapshotIfUnchanged(entry)) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_carrier_changed');
    }
  }
}
