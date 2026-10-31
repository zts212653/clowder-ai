import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { arrangeAttentionRows, buildAttentionClusters } from '../attention-clusters';
import { attentionItemKey, orderAttentionList } from '../attention-list-order';
import { buildSidebarTabContent } from '../thread-utils';

function row(id: string, activity: number, facts: Partial<SidebarSnapshotRow> = {}): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    projectPath: 'default',
    lastActiveAt: activity,
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...facts,
  };
}
function ordered(rows: SidebarSnapshotRow[], groups: { id: string; threadIds: string[] }[] = []) {
  const unread = new Set(rows.filter((row) => row.unreadCount > 0).map((row) => row.id));
  const source = buildSidebarTabContent('recent', rows, new Set(), unread).threads;
  return orderAttentionList(
    arrangeAttentionRows(source, rows, buildAttentionClusters(rows, groups), 'recent'),
    () => true,
    {},
    undefined,
    true,
  );
}

// An older unread reply must stay discoverable above newer read activity. Group
// members retain their own recent rule: restoring the outer rule must not undo it.
describe('v2 outer attention versus inner recency', () => {
  it('keeps pin, canonical working start/id, unread, activity and deterministic ties outside', () => {
    const rows = [
      row('read-new', 100),
      row('unread-old', 1, { unreadCount: 1 }),
      row('working-late', 90, { presence: { status: 'working', activeSince: 20 } }),
      row('working-early-b', 1, { presence: { status: 'working', activeSince: 10 } }),
      row('working-early-a', 2, { presence: { status: 'working', activeSince: 10 } }),
      row('pinned-idle', 0, { pinned: true }),
    ];
    expect(ordered(rows).items.map(attentionItemKey)).toEqual([
      'thread:pinned-idle',
      'thread:working-early-a',
      'thread:working-early-b',
      'thread:working-late',
      'thread:unread-old',
      'thread:read-new',
    ]);
  });
  it('ranks each Group by its foremost attention member while sorting its members by recency', () => {
    const rows = [row('old-unread', 1, { unreadCount: 1 }), row('group-new-read', 20), row('outside-new-read', 100)];
    const result = ordered(rows, [{ id: 'u', threadIds: ['old-unread', 'group-new-read'] }]);
    expect(result.items.map(attentionItemKey)).toEqual(['group:u', 'thread:outside-new-read']);
    const group = result.items[0];
    expect(group?.kind === 'cluster' && group.members.map((member) => member.id)).toEqual([
      'group-new-read',
      'old-unread',
    ]);
  });
  it('does not combine one member pin with another member activity to overtake a newer pinned thread', () => {
    const rows = [
      row('old-pin', 1, { pinned: true }),
      row('recent-unpinned', 100),
      row('outside-pin', 50, { pinned: true }),
    ];
    expect(ordered(rows, [{ id: 'g', threadIds: ['old-pin', 'recent-unpinned'] }]).items.map(attentionItemKey)).toEqual(
      ['thread:outside-pin', 'group:g'],
    );
  });
  it('raises an older unread Group above a newer read Group and follows canonical working starts', () => {
    const groups = [
      { id: 'u', threadIds: ['u1', 'u2'] },
      { id: 'r', threadIds: ['r1', 'r2'] },
    ];
    const rows = [row('u1', 1, { unreadCount: 1 }), row('u2', 2), row('r1', 90), row('r2', 100)];
    expect(ordered(rows, groups).items.map(attentionItemKey)).toEqual(['group:u', 'group:r']);
    rows[2] = row('r1', 90, { presence: { status: 'working', activeSince: 20 } });
    rows[1] = row('u2', 2, { presence: { status: 'working', activeSince: 10 } });
    expect(ordered([...rows].reverse(), groups).items.map(attentionItemKey)).toEqual(['group:u', 'group:r']);
  });
  it('keeps equal-time peers stable after reading and after source arrival order reverses', () => {
    const rows = [row('b', 100), row('a', 100, { unreadCount: 1, presence: { status: 'done' } })];
    expect(ordered(rows).items.map(attentionItemKey)).toEqual(['thread:a', 'thread:b']);
    rows[1] = row('a', 100);
    expect(ordered(rows).items.map(attentionItemKey)).toEqual(['thread:a', 'thread:b']);
    expect(ordered([...rows].reverse()).items.map(attentionItemKey)).toEqual(['thread:a', 'thread:b']);
  });
});
