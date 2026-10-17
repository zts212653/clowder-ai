'use client';

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { GenericApprovalItemCard } from './GenericApprovalItemCard';
import { MemoryCorrectionApprovalCard } from './memory/page/MemoryCorrectionApprovalCard';
import { DomainApprovalCard, isDomainApprovalFeature } from './rich/DomainApprovalCard';
import { EvalRepairApprovalCard } from './rich/EvalRepairApprovalCard';
import { PersonMemoryApprovalCard } from './rich/PersonMemoryApprovalCard';
import { ScheduleMutationProposalCard } from './rich/ScheduleMutationProposalCard';

/** Render current Host approvals through the shared presentation card. */
export function ApprovalItemCard({ item }: { item: ApprovalHubItem }) {
  if (item.sourceFeatureId === 'F276') return <PersonMemoryApprovalCard item={item} />;
  if (item.sourceFeatureId === 'F321') return <MemoryCorrectionApprovalCard item={item} />;
  if (item.sourceFeatureId === 'F139') return <ScheduleMutationProposalCard item={item} />;
  if (item.sourceFeatureId === 'F266') return <EvalRepairApprovalCard item={item} />;
  if (isDomainApprovalFeature(item.sourceFeatureId)) return <DomainApprovalCard item={item} />;
  return <GenericApprovalItemCard item={item} />;
}
