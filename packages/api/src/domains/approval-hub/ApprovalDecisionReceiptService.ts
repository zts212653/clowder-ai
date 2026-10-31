import { createHash } from 'node:crypto';
import {
  type ApprovalDecisionReceiptV1,
  approvalDecisionReceiptV1Schema,
  approvalProducerMeta,
  normalizeApprovalLifecycleProjection,
  type SettledApprovalItem,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ApprovalDecisionReceiptOutbox, ApprovalDecisionSubject } from './ApprovalDecisionReceiptOutbox.js';
import type { ApprovalProducerRegistry } from './ApprovalProducerRegistry.js';
import {
  appendDecisionReceiptToActiveRun,
  type ReceiptAppendLogger,
  type ReceiptAppendTracker,
} from './approval-decision-receipt-append.js';

interface ReceiptOptions {
  registry: ApprovalProducerRegistry;
  messageStore: Pick<IMessageStore, 'appendIdempotent'>;
  outbox: ApprovalDecisionReceiptOutbox;
  logger: ReceiptAppendLogger;
  invocationTracker?: ReceiptAppendTracker;
}

/** A delivery projection of producer truth, never a second decision store. */
export class ApprovalDecisionReceiptService {
  private readonly active = new Set<Promise<boolean>>();

  constructor(private readonly opts: ReceiptOptions) {
    for (const { id } of opts.registry.manifest()) {
      if (typeof opts.registry.get(id).adapter.readDecision !== 'function') {
        throw new Error(`Approval producer ${id} lacks an exact canonical decision receipt reader`);
      }
    }
  }

  prepare(subject: ApprovalDecisionSubject): void {
    this.opts.outbox.enqueue(subject);
  }

  async recover(): Promise<boolean> {
    try {
      const subjects = this.opts.outbox.list();
      const results = await Promise.all(subjects.map((subject) => this.deliver(subject)));
      return results.every(Boolean);
    } catch (error) {
      this.opts.logger.warn({ err: error }, 'Approval receipt outbox read pending recovery');
      return false;
    }
  }

  deliver(subject: ApprovalDecisionSubject): Promise<boolean> {
    const work = this.deliverSubject(subject).finally(() => this.active.delete(work));
    this.active.add(work);
    return work;
  }

  async drain(): Promise<void> {
    await Promise.all(this.active);
  }

  private async deliverSubject(subject: ApprovalDecisionSubject): Promise<boolean> {
    const { registry, messageStore, outbox, logger } = this.opts;
    const { ownerUserId } = subject;
    try {
      outbox.attempted(subject);
      const adapter = registry.get(subject.producerId).adapter;
      const decision = await adapter.readDecision!(ownerUserId, subject.canonicalProposalId);
      // An in-flight decision may still be open during recovery. Keep its intent
      // until the producer proves a terminal state; never expire by wall clock.
      if (decision.state === 'pending') return false;
      if (decision.state === 'decided') {
        const receipt = decisionReceipt(decision.item);
        if (
          !receipt ||
          decision.item.ownerUserId !== ownerUserId ||
          receipt.producerId !== subject.producerId ||
          receipt.canonicalProposalId !== subject.canonicalProposalId
        ) {
          throw new Error('Canonical approval decision receipt identity mismatch');
        }
        const appended = await messageStore.appendIdempotent({
          userId: ownerUserId,
          from: { kind: 'system', service: 'approval-hub' },
          threadId: receipt.approvalCardRef.threadId,
          content: renderDecisionReceipt(receipt),
          mentions: [],
          timestamp: Date.now(),
          idempotencyKey: receiptKey(receipt),
          source: {
            connector: 'approval-hub',
            label: 'Host 审批结果回执',
            icon: '📋',
            meta: { presentation: 'system_notice', approvalDecisionReceipt: receipt },
          },
        });
        // Permanent message idempotency also fences the optional provider call.
        // Replays (including recovery after a committed append lost its ACK)
        // only retain the message. There is no second live-delivery state layer.
        if (!appended.idempotent && this.opts.invocationTracker) {
          await appendDecisionReceiptToActiveRun({
            ownerUserId,
            receipt,
            message: appended.message,
            invocationTracker: this.opts.invocationTracker,
            logger,
          });
        }
      }
      // A crash after append and before removal replays the message's atomic,
      // permanent idempotency key, rather than creating a second receipt.
      outbox.remove(subject);
      return true;
    } catch (error) {
      logger.warn({ err: error, ...subject }, 'Approval decision unchanged; origin-thread receipt pending recovery');
      return false;
    }
  }
}

function decisionReceipt(item: SettledApprovalItem): ApprovalDecisionReceiptV1 | null {
  const { resolution } = normalizeApprovalLifecycleProjection({ status: item.status });
  if (item.navigation.state !== 'anchored' || !['accepted', 'rejected'].includes(resolution)) return null;
  const reason = item.detail.rejectionReason;
  return approvalDecisionReceiptV1Schema.parse({
    v: 1,
    kind: 'approval_decision_receipt',
    producerId: item.sourceFeatureId,
    canonicalProposalId: item.proposalId,
    resolution,
    approvalCardRef: item.navigation.approvalCardRef,
    requesterCatId: item.requesterCatId,
    decidedAt: item.decidedAt,
    decidedBy: item.decidedBy,
    ...(resolution === 'rejected' && typeof reason === 'string' && reason.trim()
      ? { rejectionReason: reason.trim().slice(0, 500) }
      : {}),
  });
}

function receiptKey(receipt: ApprovalDecisionReceiptV1): string {
  const identity = JSON.stringify([receipt.producerId, receipt.canonicalProposalId, receipt.resolution]);
  return `approval-decision:v1:${createHash('sha256').update(identity).digest('hex')}`;
}

function renderDecisionReceipt(receipt: ApprovalDecisionReceiptV1): string {
  const result = receipt.resolution === 'accepted' ? '已批准' : '已拒绝';
  const text = `审批结果：${approvalProducerMeta(receipt.producerId).label}提案 ${receipt.canonicalProposalId} ${result}。`;
  return receipt.rejectionReason ? `${text}\n拒绝理由：${receipt.rejectionReason}` : text;
}
