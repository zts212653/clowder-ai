import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';

type ReportBinding = Pick<
  DevelopmentReturnRegistrationV1,
  'ownerUserId' | 'executionThreadId' | 'reporterCatIds' | 'report'
>;

type ReportAdmissionBinding = Pick<
  DevelopmentReturnRegistrationV1,
  | 'ownerUserId'
  | 'ownerThreadId'
  | 'ownerCatId'
  | 'taskRef'
  | 'executionThreadId'
  | 'reporterCatIds'
  | 'registeredAt'
  | 'predecessorRegistrationId'
>;

function isPersistedAgentReport(
  message: StoredMessage | null,
  binding: Pick<ReportAdmissionBinding, 'ownerUserId' | 'executionThreadId' | 'reporterCatIds'>,
): message is StoredMessage {
  return Boolean(
    message &&
      !message.deletedAt &&
      !message._tombstone &&
      !message.source &&
      !message.sourceParseFailure &&
      message.userId === binding.ownerUserId &&
      message.threadId === binding.executionThreadId &&
      message.catId !== null &&
      binding.reporterCatIds.includes(message.catId),
  );
}

function wasPersistedAfter(message: StoredMessage, lowerBound: StoredMessage): boolean {
  return (
    message.timestamp > lowerBound.timestamp ||
    (message.timestamp === lowerBound.timestamp && message.id > lowerBound.id)
  );
}

/** Immutable V1 body used by both delivery and legacy wake verification. Add a new version to change it. */
export function renderDevelopmentReturnWakeContentV1(state: DevelopmentReturnRegistrationV1): string {
  return (
    `[开发责任续办] registration=${state.registrationId}; signal=${state.reason}; ${state.taskRef} observedRevision=${state.observedRevision}; currentRevision=${state.deliveryRevision}（投递认领时；行动前重读）\n` +
    (state.report
      ? `执行现场已提交 ${state.report.outcome}；sourceMessage=${state.report.sourceMessageId}；evidence=${state.report.evidenceRefs.join(', ')}。\n`
      : '回流预算到期：这只是一次当前事实复核，不代表成功，不重派执行或催促其他猫。\n') +
    '由原 owner 先重读同一 Task、当前授权和产物，再执行确切 owner action 或注册有据的合法后继；报告/唤醒本身不算工作完成。'
  );
}

/**
 * A first return accepts only a report persisted after registration. An explicit successor may also
 * consume the original report that arrived after its predecessor's durable deadline-review wake but
 * before the owner could register that successor. The wake is the lower bound; older child speech is
 * never reclassified as a terminal result.
 */
export function isAdmissibleDevelopmentReturnReport(
  message: StoredMessage | null,
  binding: ReportAdmissionBinding,
  reporterCatId: string,
  predecessor: DevelopmentReturnRegistrationV1 | null,
  predecessorWake: StoredMessage | null,
): message is StoredMessage {
  if (!isPersistedAgentReport(message, binding) || message.catId !== reporterCatId) return false;
  return isCurrentDevelopmentReturnReportWindow(message, binding, predecessor, predecessorWake);
}

/** Revalidate the temporal proof used when a successor consumes a pre-registration report. */
export function isCurrentDevelopmentReturnReportWindow(
  message: StoredMessage | null,
  binding: ReportAdmissionBinding,
  predecessor: DevelopmentReturnRegistrationV1 | null,
  predecessorWake: StoredMessage | null,
): boolean {
  if (!message) return false;
  if (message.timestamp >= binding.registeredAt) return true;
  if (!binding.predecessorRegistrationId || !predecessor || !predecessorWake || message.catId === null) {
    return false;
  }
  const wakeSource = predecessorWake?.source;
  const wakeMeta = wakeSource?.meta;
  const wakeFrom = predecessorWake?.from;
  const expectedWakeRevision = deriveGrowingSourceMessageRevision({
    content: renderDevelopmentReturnWakeContentV1(predecessor),
    contentBlocks: undefined,
  });
  return (
    predecessor.registrationId === binding.predecessorRegistrationId &&
    predecessor.ownerUserId === binding.ownerUserId &&
    predecessor.ownerThreadId === binding.ownerThreadId &&
    predecessor.ownerCatId === binding.ownerCatId &&
    predecessor.taskRef === binding.taskRef &&
    predecessor.executionThreadId === binding.executionThreadId &&
    predecessor.reporterCatIds.includes(message.catId) &&
    predecessor.status === 'delivered' &&
    predecessor.reason === 'deadline_review' &&
    !predecessor.report &&
    predecessor.deliveryRevision !== undefined &&
    predecessor.wakeMessageId !== undefined &&
    predecessorWake.id === predecessor.wakeMessageId &&
    !predecessorWake.deletedAt &&
    !predecessorWake._tombstone &&
    !predecessorWake.sourceParseFailure &&
    predecessorWake.userId === binding.ownerUserId &&
    predecessorWake.threadId === binding.ownerThreadId &&
    predecessorWake.catId === null &&
    wakeFrom?.kind === 'external' &&
    wakeFrom.connectorId === 'development-return' &&
    predecessorWake.lifecycle?.kind === 'input' &&
    predecessorWake.deliveryStatus !== 'canceled' &&
    wakeSource?.connector === 'development-return' &&
    wakeMeta?.registrationId === predecessor.registrationId &&
    wakeMeta?.taskRef === predecessor.taskRef &&
    wakeMeta?.observedRevision === String(predecessor.observedRevision) &&
    wakeMeta?.currentRevision === String(predecessor.deliveryRevision) &&
    wakeMeta?.reason === 'deadline_review' &&
    deriveGrowingSourceMessageRevision(predecessorWake) === expectedWakeRevision &&
    wasPersistedAfter(message, predecessorWake)
  );
}

/** Re-read one persisted terminal report instead of trusting its stored fingerprint alone. */
export function isCurrentDevelopmentReturnReport(
  message: StoredMessage | null,
  binding: ReportBinding,
  additionalReporterSet?: readonly string[],
): message is StoredMessage {
  const publication = binding.report;
  if (!publication || !isPersistedAgentReport(message, binding) || message.catId === null) return false;
  return (
    message.id === publication.sourceMessageId &&
    (!additionalReporterSet || additionalReporterSet.includes(message.catId)) &&
    deriveGrowingSourceMessageRevision(message) === publication.sourceMessageRevision
  );
}
