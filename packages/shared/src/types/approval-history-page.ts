import type { ApprovalProducerId, SettledApprovalHubItem } from './approval-hub.js';
import type { ApprovalResolution } from './approval-lifecycle.js';

/** Redis ZSET and SQLite BINARY use UTF-8 byte order, including non-ASCII producer ids. */
export function compareApprovalHistoryId(left: string, right: string): number {
  if (left === right) return 0;
  if (/^[\x00-\x7f]*$/u.test(left) && /^[\x00-\x7f]*$/u.test(right)) return left < right ? 1 : -1;
  const encoder = new TextEncoder(),
    a = encoder.encode(left),
    b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++)
    if (a[index] !== b[index]) return b[index] - a[index];
  return b.length - a.length;
}

export function compareApprovalHistoryItems(
  left: Pick<SettledApprovalHubItem, 'decidedAt' | 'sourceFeatureId' | 'proposalId'>,
  right: Pick<SettledApprovalHubItem, 'decidedAt' | 'sourceFeatureId' | 'proposalId'>,
): number {
  return (
    right.decidedAt - left.decidedAt ||
    compareApprovalHistoryId(left.sourceFeatureId, right.sourceFeatureId) ||
    compareApprovalHistoryId(left.proposalId, right.proposalId)
  );
}

/** Read-only, owner-fenced keyset page. A count is the size of this page, never a total. */
export interface ApprovalHistoryPageRequest {
  limit?: number;
  cursor?: string;
  producer?: ApprovalProducerId;
  resolution?: Exclude<ApprovalResolution, 'open'>;
}

export interface ApprovalHistoryPage {
  items: SettledApprovalHubItem[];
  count: number;
  manifest: ReadonlyArray<{ id: ApprovalProducerId }>;
  identity: { ownerUserId: string };
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
  /** Complete up to this page's frontier. hasMore alone states whether older entries remain. */
  coverage: { state: 'complete'; orderVersion: 1; sources: ApprovalProducerId[] };
}
