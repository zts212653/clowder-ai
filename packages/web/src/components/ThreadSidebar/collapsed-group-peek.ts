import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';

export type GroupPeekReason = 'decision' | 'mention' | 'unread';
export interface GroupPeekEntry {
  member: SidebarSnapshotRow;
  reason: GroupPeekReason;
}
export interface GroupPeekProjection {
  entries: GroupPeekEntry[];
  total: number;
}
export function collapsedGroupPeek(
  members: readonly SidebarSnapshotRow[],
  decisionThreadIds: ReadonlySet<string>,
): GroupPeekProjection {
  const entries = members.flatMap((member): GroupPeekEntry[] => {
    const reason = decisionThreadIds.has(member.id)
      ? 'decision'
      : member.hasUserMention
        ? 'mention'
        : member.unreadCount > 0
          ? 'unread'
          : null;
    return reason ? [{ member, reason }] : [];
  });
  const priority = { decision: 0, mention: 1, unread: 2 };
  entries.sort((left, right) => priority[left.reason] - priority[right.reason]);
  return { entries: entries.slice(0, 3), total: entries.length };
}
