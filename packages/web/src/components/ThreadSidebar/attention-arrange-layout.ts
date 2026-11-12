import type { ThreadAttentionGroup, ThreadAttentionMemberSort } from '@cat-cafe/shared';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { type AttentionCluster, type AttentionListRow, flattenAttentionRows } from './attention-clusters';
import { orderGroupMemberIds } from './attention-list-order';

type ArrangeItem =
  | { kind: 'thread'; id: string }
  | { kind: 'group'; anchor: string; memberIds: string[]; visibleCount: number; expanded: boolean };
export type ArrangeLayout = Record<string, ArrangeItem[]>;

/** Keep layout IDs only. Every rendered title, pin and signal still comes from the live snapshot. */
export function captureArrangeLayout(
  full: Record<string, AttentionListRow[]>,
  visible: Record<string, AttentionListRow[]>,
): ArrangeLayout {
  return Object.fromEntries(
    Object.entries(full).map(([key, rows]) => [
      key,
      rows.flatMap<ArrangeItem>((row) => {
        if (row.kind === 'thread') return [{ kind: 'thread' as const, id: row.thread.id }];
        if (row.kind !== 'cluster-header') return [];
        const members = row.expanded
          ? rows.flatMap((candidate) =>
              candidate.kind === 'cluster-member' && candidate.cluster.anchor === row.cluster.anchor
                ? [candidate.member.id]
                : [],
            )
          : row.members.map((member) => member.id);
        return [
          {
            kind: 'group' as const,
            anchor: row.cluster.anchor,
            memberIds: members,
            expanded: row.expanded,
            visibleCount: (visible[key] ?? []).filter(
              (candidate) => candidate.kind === 'cluster-member' && candidate.cluster.anchor === row.cluster.anchor,
            ).length,
          },
        ];
      }),
    ]),
  );
}

export function projectArrangeLayout(
  layout: ArrangeLayout,
  liveRows: readonly SidebarSnapshotRow[],
  clusters: readonly AttentionCluster[],
): Record<string, AttentionListRow[]> {
  const rowsById = new Map(liveRows.map((row) => [row.id, row]));
  const groupsByAnchor = new Map(clusters.map((cluster) => [cluster.anchor, cluster]));
  return Object.fromEntries(
    Object.entries(layout).map(([key, items]) => [
      key,
      items.flatMap<AttentionListRow>((item) => {
        if (item.kind === 'thread') {
          const thread = rowsById.get(item.id);
          return thread ? [{ kind: 'thread' as const, key: `thread:${thread.id}`, thread }] : [];
        }
        const cluster = groupsByAnchor.get(item.anchor);
        if (!cluster) return [];
        const members = item.memberIds.flatMap((id) => {
          const member = rowsById.get(id);
          return member ? [member] : [];
        });
        const rows = flattenAttentionRows([{ kind: 'cluster', cluster, members }], () => item.expanded, '');
        if (!item.expanded || item.visibleCount >= members.length) return rows;
        const next = members[item.visibleCount];
        return [
          ...rows.slice(0, item.visibleCount + 1),
          ...(next
            ? [
                {
                  kind: 'cluster-remainder' as const,
                  key: `remainder:${item.anchor}`,
                  cluster,
                  remainingCount: members.length - item.visibleCount,
                  nextThreadId: next.id,
                },
              ]
            : []),
        ];
      }),
    ]),
  );
}

/** A successful membership command changes only its source row and affected group shells. */
export function moveArrangeThread(
  layout: ArrangeLayout,
  sourceId: string,
  savedGroups: readonly ThreadAttentionGroup[],
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  liveRows: readonly SidebarSnapshotRow[],
): ArrangeLayout {
  const destination = savedGroups.find((group) => group.threadIds.includes(sourceId));
  const savedAnchors = new Set(savedGroups.map((group) => `group:${group.id}`));
  const sourceList = Object.entries(layout).find(([, items]) =>
    items.some((item) => (item.kind === 'thread' ? item.id === sourceId : item.memberIds.includes(sourceId))),
  );
  if (!sourceList) return layout;
  const [sourceKey, sourceItems] = sourceList;
  const sourceIndex = sourceItems.findIndex((item) =>
    item.kind === 'thread' ? item.id === sourceId : item.memberIds.includes(sourceId),
  );
  const sourceItem = sourceItems[sourceIndex];
  const sourceVisible =
    sourceItem?.kind === 'group' && sourceItem.memberIds.indexOf(sourceId) < sourceItem.visibleCount;
  const next: ArrangeLayout = Object.fromEntries(
    Object.entries(layout).map(([key, items]) => [
      key,
      items.flatMap<ArrangeItem>((item) => {
        if (item.kind === 'thread') return item.id === sourceId ? [] : [item];
        if (!item.memberIds.includes(sourceId)) return [item];
        const memberIds = item.memberIds.filter((id) => id !== sourceId);
        if (!savedAnchors.has(item.anchor)) return memberIds.map((id) => ({ kind: 'thread' as const, id }));
        return [{ ...item, memberIds, visibleCount: item.visibleCount - (sourceVisible ? 1 : 0) }];
      }),
    ]),
  );
  if (!destination) {
    next[sourceKey]?.splice(sourceIndex + 1, 0, { kind: 'thread', id: sourceId });
    return next;
  }
  const destinationAnchor = `group:${destination.id}`;
  const rowsById = new Map(liveRows.map((row) => [row.id, row]));
  const mode = modes[destinationAnchor] ?? 'recent';
  for (const items of Object.values(next)) {
    const target = items.find((item) => item.kind === 'group' && item.anchor === destinationAnchor);
    if (target?.kind !== 'group') continue;
    const showAll = target.visibleCount === target.memberIds.length;
    const sameGroup = sourceItem?.kind === 'group' && sourceItem.anchor === target.anchor;
    let memberIds: string[];
    if (sameGroup && mode === 'manual') {
      const admitted = new Set([...target.memberIds, sourceId]);
      memberIds = destination.threadIds.filter((id) => admitted.has(id));
    } else {
      memberIds = [...target.memberIds];
      const ranked = orderGroupMemberIds(
        [...memberIds, sourceId].flatMap((id) => {
          const row = rowsById.get(id);
          return row ? [row] : [];
        }),
        mode,
        true,
      );
      const sourceRank = ranked.indexOf(sourceId);
      const insertion = mode === 'manual' ? -1 : memberIds.findIndex((id) => ranked.indexOf(id) > sourceRank);
      memberIds.splice(insertion < 0 ? memberIds.length : insertion, 0, sourceId);
    }
    const rank = memberIds.indexOf(sourceId);
    items[items.indexOf(target)] = {
      ...target,
      memberIds,
      visibleCount: target.visibleCount + Number(showAll || rank < target.visibleCount || (sameGroup && sourceVisible)),
    };
    return next;
  }
  // A newly created group replaces its target conversation, at that conversation's old location.
  for (const items of Object.values(next)) {
    const targetIndex = items.findIndex((item) => item.kind === 'thread' && destination.threadIds.includes(item.id));
    if (targetIndex < 0) continue;
    const memberIds = orderGroupMemberIds(
      destination.threadIds.flatMap((id) => {
        const row = rowsById.get(id);
        return row ? [row] : [];
      }),
      mode,
      true,
    );
    items.splice(targetIndex, 1, {
      kind: 'group',
      anchor: destinationAnchor,
      memberIds,
      visibleCount: memberIds.length,
      expanded: true,
    });
    return next;
  }
  return next;
}
