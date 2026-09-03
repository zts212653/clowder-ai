import type { ApprovalProducerId } from '@cat-cafe/shared';
import { approvalFeatureMeta } from '@/lib/approval-features';

export function ApprovalFeatureBadge({ featureId, testId }: { featureId: ApprovalProducerId; testId?: string }) {
  const featureMeta = approvalFeatureMeta(featureId);
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-micro font-medium"
      style={{ backgroundColor: featureMeta.color, color: 'var(--cafe-accent-foreground)' }}
      data-testid={testId}
    >
      {featureMeta.label}
    </span>
  );
}
