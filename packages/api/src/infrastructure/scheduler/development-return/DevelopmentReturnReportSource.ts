import type { DevelopmentReturnRegistrationV1 } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';

type ReportBinding = Pick<
  DevelopmentReturnRegistrationV1,
  'ownerUserId' | 'executionThreadId' | 'reporterCatIds' | 'report'
>;

/** Re-read one persisted terminal report instead of trusting its stored fingerprint alone. */
export function isCurrentDevelopmentReturnReport(
  message: StoredMessage | null,
  binding: ReportBinding,
  additionalReporterSet?: readonly string[],
): message is StoredMessage {
  const publication = binding.report;
  return Boolean(
    publication &&
      message &&
      message.id === publication.sourceMessageId &&
      !message.deletedAt &&
      !message._tombstone &&
      !message.source &&
      !message.sourceParseFailure &&
      message.userId === binding.ownerUserId &&
      message.threadId === binding.executionThreadId &&
      message.catId !== null &&
      binding.reporterCatIds.includes(message.catId) &&
      (!additionalReporterSet || additionalReporterSet.includes(message.catId)) &&
      deriveGrowingSourceMessageRevision(message) === publication.sourceMessageRevision,
  );
}
