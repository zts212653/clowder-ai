import type { UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalDisplayTitle } from '@/lib/approval-presentation';

/**
 * The proposing cat leads the line, once. Some titles already start with that cat's name (a session handoff is "<cat> → …"):
 * then that name is the lead-in and is taken out of the title, rather than printed a second time in front of it.
 */
export function leadAndTitle(name: string, title: string): { lead: string; title: string } {
  return title.startsWith(name) ? { lead: name, title: title.slice(name.length).trimStart() } : { lead: name, title };
}

/** How an approval is named in the panel: "who proposed what". One rule for its row and for a result that outlives the row. */
export function useApprovalHeading(approval: UnifiedAttentionVisibleApproval): { lead: string; title: string } {
  const resolveCatName = useCatNameResolver();
  return leadAndTitle(resolveCatName(approval.requesterCatId), approvalDisplayTitle(approval, { resolveCatName }));
}
