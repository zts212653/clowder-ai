import type { ApprovalNavigation, ApprovalPublication } from '@cat-cafe/shared';
import { validateApprovalEnvelope } from '@cat-cafe/shared';

export interface LegacyApprovalLocation {
  legacyThreadId?: string;
  legacyMessageId?: string;
}

/**
 * Projects canonical publication metadata without guessing missing anchors.
 * Undefined publication means a pre-Phase-I record and is shown honestly as
 * legacy_unanchored. staged/tombstoned records are not Hub-visible.
 */
export function projectApprovalNavigation(record: object, legacy: LegacyApprovalLocation): ApprovalNavigation | null {
  const publication = (record as { publication?: ApprovalPublication }).publication;
  if (publication === undefined) return legacyNavigation(legacy);

  switch (publication.state) {
    case 'anchored':
      validateApprovalEnvelope(publication.envelope);
      return {
        state: 'anchored',
        originRef: publication.envelope.originRef,
        approvalCardRef: publication.envelope.approvalCardRef,
      };
    case 'legacy_unanchored':
      return legacyNavigation({
        legacyThreadId: publication.legacyThreadId,
        legacyMessageId: publication.legacyMessageId,
      });
    case 'staged':
    case 'tombstoned':
      return null;
  }
}

export function compactApprovalProjections<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null);
}

function legacyNavigation(legacy: LegacyApprovalLocation): ApprovalNavigation {
  return {
    state: 'legacy_unanchored',
    ...(legacy.legacyThreadId ? { legacyThreadId: legacy.legacyThreadId } : {}),
    ...(legacy.legacyMessageId ? { legacyMessageId: legacy.legacyMessageId } : {}),
  };
}
