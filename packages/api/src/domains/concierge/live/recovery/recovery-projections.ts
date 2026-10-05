import type { SettledApprovalHubItem, TaskItem } from '@cat-cafe/shared';
import { canViewMessage, isDurablyReadableByCat } from '../../../cats/services/stores/visibility.js';
import type { LiveInboxScope } from '../inbox/live-inbox-contract.js';
import { type LiveRecoveryOptions, recoveryExcerpt } from './live-recovery-contract.js';

export class RecoveryProjections {
  constructor(
    private readonly options: LiveRecoveryOptions,
    private readonly scope: LiveInboxScope,
  ) {}

  async visibleMessage(messageId: string, threadId = this.scope.threadId) {
    if (threadId !== this.scope.threadId) return false;
    const message = await this.options.messages.getById(messageId);
    return (
      !!message &&
      message.threadId === threadId &&
      message.userId === this.scope.userId &&
      message.deletedAt === undefined &&
      !message.recall &&
      message.deliveryStatus !== 'canceled' &&
      !message.queueCustody?.withdrawnByCatIds?.includes(this.scope.catId) &&
      canViewMessage(message, { type: 'cat', catId: this.scope.catId }) &&
      isDurablyReadableByCat(message, this.scope.catId)
    );
  }

  eligibleTask(task: TaskItem) {
    return (
      task.threadId === this.scope.threadId &&
      (task.userId === undefined || task.userId === this.scope.userId) &&
      task.kind === 'work' &&
      task.status !== 'done' &&
      (!task.entrustedWork || task.entrustedWork.closure.state === 'open')
    );
  }

  async task(taskId: string) {
    const task = await this.options.tasks.get(taskId);
    if (!task || !this.eligibleTask(task)) return null;
    if (task.sourceMessageId && !(await this.visibleMessage(task.sourceMessageId))) return null;
    // ThreadSummary has no canonical viewer ACL or source lineage. The task title/why may
    // copy private summary text, so a same-thread task cannot launder it into this cat's context.
    if (task.sourceSummaryId) return null;
    return {
      taskId: task.id,
      threadId: task.threadId,
      ownerCatId: task.ownerCatId,
      status: task.status,
      title: recoveryExcerpt(task.title),
      why: recoveryExcerpt(task.why),
      updatedAt: task.updatedAt,
      ...(task.sourceMessageId ? { sourceMessageId: task.sourceMessageId } : {}),
      ...(task.entrustedWork
        ? {
            entrustedRevision: task.entrustedWork.revision,
            intendedOutcome: recoveryExcerpt(task.entrustedWork.intendedOutcome),
          }
        : {}),
    };
  }

  eligibleDecision(item: SettledApprovalHubItem) {
    return (
      item.ownerUserId === this.scope.userId &&
      item.navigation.state === 'anchored' &&
      item.navigation.approvalCardRef.threadId === this.scope.threadId &&
      item.resolution !== 'open'
    );
  }

  async decision(item: SettledApprovalHubItem) {
    if (!this.eligibleDecision(item) || item.navigation.state !== 'anchored') return null;
    const { originRef, approvalCardRef } = item.navigation;
    if (!(await this.visibleMessage(approvalCardRef.messageId, approvalCardRef.threadId))) return null;
    if (originRef.kind === 'message' && !(await this.visibleMessage(originRef.messageId, originRef.threadId)))
      return null;
    // Event-origin approvals are anchored by the visible card; omit the raw event summary/anchor.
    return {
      proposalId: item.proposalId,
      sourceFeatureId: item.sourceFeatureId,
      requesterCatId: item.requesterCatId,
      summary: recoveryExcerpt(item.summary),
      resolution: item.resolution,
      materialization: item.materialization,
      decidedAt: item.decidedAt,
      decidedBy: item.decidedBy,
      approvalCardRef,
      ...(originRef.kind === 'message' ? { originRef } : {}),
    };
  }
}
