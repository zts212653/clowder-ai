import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { SidebarTabId } from './thread-utils';

export interface AttentionCluster {
  anchor: string;
  rootThreadId: string;
  title: string;
  memberIds: string[];
  groupId: string;
  /** Local search aid derived only after explicit membership exists; never drives membership. */
  searchText: string;
}

export type AttentionRenderItem =
  | { kind: 'thread'; thread: SidebarSnapshotRow }
  | { kind: 'cluster'; cluster: AttentionCluster; members: SidebarSnapshotRow[] };

export type AttentionListRow =
  | { kind: 'thread'; key: string; thread: SidebarSnapshotRow }
  | {
      kind: 'cluster-header';
      key: string;
      cluster: AttentionCluster;
      members: SidebarSnapshotRow[];
      expanded: boolean;
    }
  | {
      kind: 'cluster-member';
      key: string;
      cluster: AttentionCluster;
      member: SidebarSnapshotRow;
      isFirst: boolean;
      isLast: boolean;
    };

/** Build visible Groups from explicit owner-created membership only. */
export function buildAttentionClusters(
  rows: readonly SidebarSnapshotRow[],
  savedGroups: readonly ThreadAttentionGroup[] = [],
): AttentionCluster[] {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const clusters: AttentionCluster[] = [];
  const searchTextFor = (memberIds: readonly string[]) =>
    memberIds
      .flatMap((id) => {
        const member = rowById.get(id);
        return [id, member?.title ?? '', member?.projectPath ?? ''];
      })
      .join(' ');

  for (const group of savedGroups) {
    const memberIds = group.threadIds.filter((threadId) => rowById.has(threadId));
    if (memberIds.length < 2) continue;
    const rootThreadId = memberIds[0];
    if (!rootThreadId) continue;
    clusters.push({
      anchor: `group:${group.id}`,
      groupId: group.id,
      rootThreadId,
      title: group.name?.trim() || rowById.get(rootThreadId)?.title?.trim() || `${memberIds.length} 个对话`,
      memberIds,
      searchText: searchTextFor(memberIds),
    });
  }
  return clusters;
}

function resolveEligibleMembers(
  cluster: AttentionCluster,
  visibleIds: ReadonlySet<string>,
  allRowById: ReadonlyMap<string, SidebarSnapshotRow>,
  tab: SidebarTabId,
): SidebarSnapshotRow[] | null {
  const visibleMemberIds = cluster.memberIds.filter((id) => visibleIds.has(id));
  const eligible =
    tab === 'pinned' ? visibleMemberIds.some((id) => allRowById.get(id)?.pinned) : visibleMemberIds.length > 0;
  if (!eligible) return null;
  return cluster.memberIds
    .map((id) => allRowById.get(id))
    .filter((candidate): candidate is SidebarSnapshotRow => candidate !== undefined);
}

/**
 * Compose a tab's rows with explicit Groups. In the pinned tab, any pinned member
 * anchors the full Group closure; individual rows keep their own pin truth.
 */
export function arrangeAttentionRows(
  visibleRows: readonly SidebarSnapshotRow[],
  allRows: readonly SidebarSnapshotRow[],
  clusters: readonly AttentionCluster[],
  tab: SidebarTabId,
): AttentionRenderItem[] {
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  const allRowById = new Map(allRows.map((row) => [row.id, row]));
  const clusterByMember = new Map<string, AttentionCluster>();
  for (const cluster of clusters) {
    for (const memberId of cluster.memberIds) clusterByMember.set(memberId, cluster);
  }

  const emitted = new Set<string>();
  const result: AttentionRenderItem[] = [];
  for (const row of visibleRows) {
    const cluster = clusterByMember.get(row.id);
    if (!cluster) {
      result.push({ kind: 'thread', thread: row });
      continue;
    }
    if (emitted.has(cluster.anchor)) continue;
    const members = resolveEligibleMembers(cluster, visibleIds, allRowById, tab);
    if (!members) continue;
    if (members.length < 2) {
      if (members[0]) result.push({ kind: 'thread', thread: members[0] });
      continue;
    }
    emitted.add(cluster.anchor);
    result.push({ kind: 'cluster', cluster, members });
  }
  return result;
}

function memberMatches(member: SidebarSnapshotRow, query: string): boolean {
  return `${member.title ?? ''} ${member.id} ${member.projectPath}`.toLocaleLowerCase().includes(query);
}

/** Flatten cluster presentation into fixed-height visual rows so large grouped lists remain virtualizable. */
export function flattenAttentionRows(
  items: readonly AttentionRenderItem[],
  isOpen: (cluster: AttentionCluster) => boolean,
  query: string,
): AttentionListRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows: AttentionListRow[] = [];
  for (const item of items) {
    if (item.kind === 'thread') {
      rows.push({ kind: 'thread', key: `thread:${item.thread.id}`, thread: item.thread });
      continue;
    }

    const expanded = isOpen(item.cluster);
    rows.push({
      kind: 'cluster-header',
      key: `cluster:${item.cluster.anchor}`,
      cluster: item.cluster,
      members: item.members,
      expanded,
    });
    if (!expanded) continue;

    const headerMatches = item.cluster.title.toLocaleLowerCase().includes(normalizedQuery);
    const visibleMembers =
      normalizedQuery && !headerMatches
        ? item.members.filter((member) => memberMatches(member, normalizedQuery))
        : item.members;
    visibleMembers.forEach((member, index) => {
      rows.push({
        kind: 'cluster-member',
        key: `cluster-member:${item.cluster.anchor}:${member.id}`,
        cluster: item.cluster,
        member,
        isFirst: index === 0,
        isLast: index === visibleMembers.length - 1,
      });
    });
  }
  return rows;
}

export function resolveAttentionClusterOpen(
  cluster: AttentionCluster,
  preferences: Readonly<Record<string, boolean>>,
  currentThreadId: string,
  searchQuery: string,
): boolean {
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  if (normalizedQuery) {
    const haystack = `${cluster.title} ${cluster.searchText}`.toLocaleLowerCase();
    if (haystack.includes(normalizedQuery)) return true;
  }
  if (Object.hasOwn(preferences, cluster.anchor)) return preferences[cluster.anchor] ?? false;
  return cluster.memberIds.includes(currentThreadId);
}
