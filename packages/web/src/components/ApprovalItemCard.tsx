'use client';

import type { ApprovalItem } from '@cat-cafe/shared';
import { GenericApprovalItemCard } from './GenericApprovalItemCard';
import { MeetingIntakeCard } from './MeetingIntakeCard';

/**
 * Feature-owned adapter dispatch for the Approval Hub.
 *
 * F292 keeps its feature-owned business adapter while both adapter paths
 * supply data and actions to the shared presentation-only ApprovalDecisionCard.
 */
export function ApprovalItemCard({ item }: { item: ApprovalItem }) {
  if (item.sourceFeatureId === 'F292') return <MeetingIntakeCard item={item} />;
  return <GenericApprovalItemCard item={item} />;
}
