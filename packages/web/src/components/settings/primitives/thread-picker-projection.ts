import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  type AttentionCluster,
  type AttentionListRow,
  arrangeAttentionRows,
  flattenAttentionRows,
} from '../../ThreadSidebar/attention-clusters';
import { orderAttentionList } from '../../ThreadSidebar/attention-list-order';
import { matchesThreadSearch } from '../../ThreadSidebar/thread-search';
import { buildSidebarTabContent } from '../../ThreadSidebar/thread-utils';

/**
 * Compose the picker from the same Sidebar snapshot and attention config as the Sidebar:
 * pinned/recent order, owner-created Groups, member sort, then the search projection.
 * Selection is deliberately not an input: checking a row can never move it.
 */
export function buildThreadPickerRows({
  rows,
  clusters,
  memberSort,
  query,
}: {
  rows: readonly SidebarSnapshotRow[];
  clusters: readonly AttentionCluster[];
  memberSort: Readonly<Partial<Record<string, ThreadAttentionMemberSort>>>;
  query: string;
}): AttentionListRow[] {
  const unreadIds = new Set(rows.filter((row) => row.unreadCount > 0).map((row) => row.id));
  const recent = buildSidebarTabContent('recent', [...rows], new Set<string>(), unreadIds).threads;
  const arranged = arrangeAttentionRows(recent, rows, clusters, 'recent');
  const ordered = orderAttentionList(arranged, () => true, memberSort, undefined, true).items;
  const flattened = flattenAttentionRows(ordered, () => true, query);

  // `flattenAttentionRows` filters Group members; standalone thread rows need the same search.
  const normalizedQuery = query.trim();
  const searched =
    normalizedQuery.length === 0
      ? flattened
      : flattened.filter((row) => row.kind !== 'thread' || matchesThreadSearch(row.thread, normalizedQuery));

  // A search can hide every member of a Group. Do not leave a header with no visible rows.
  return searched.filter((row, index) => {
    if (row.kind !== 'cluster-header') return true;
    for (const candidate of searched.slice(index + 1)) {
      if (candidate.kind === 'cluster-header') return false;
      if (candidate.kind === 'cluster-member' && candidate.cluster.anchor === row.cluster.anchor) return true;
      if (candidate.kind === 'thread') return false;
    }
    return false;
  });
}
