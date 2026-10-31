import type { ApprovalProducerId } from '@cat-cafe/shared';
import { approvalFeatureMeta } from '@/lib/approval-features';

import { useShellLanguage } from './shell/shell-language';

export function ApprovalFeatureBadge({ featureId, testId }: { featureId: ApprovalProducerId; testId?: string }) {
  const language = useShellLanguage();
  const featureMeta = approvalFeatureMeta(featureId);
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-micro font-medium"
      style={{ backgroundColor: featureMeta.color, color: 'var(--cafe-accent-foreground)' }}
      data-testid={testId}
    >
      {language === 'en' ? featureMeta.badgeLabel : featureMeta.label}
    </span>
  );
}
