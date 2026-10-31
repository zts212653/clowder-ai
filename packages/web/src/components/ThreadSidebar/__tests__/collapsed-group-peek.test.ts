import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { collapsedGroupPeek } from '../collapsed-group-peek';

function member(id: string, overrides: Partial<SidebarSnapshotRow> = {}): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: 'default',
    lastActiveAt: 1,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...overrides,
  };
}

describe('collapsed Group shows the conversations that need reading', () => {
  it('shows the only unread member, omitting mere work and quiet members', () => {
    const one = member('one', { unreadCount: 2 });
    const result = collapsedGroupPeek(
      [member('work', { presence: { status: 'working' } }), one, member('quiet')],
      new Set(),
    );
    expect(result).toEqual({ entries: [{ member: one, reason: 'unread' }], total: 1 });
  });
  it('deduplicates conversations, prioritizes decisions then mentions then unread, and caps at three', () => {
    const members = [
      member('new-a', { unreadCount: 3 }),
      member('mention', { unreadCount: 1, hasUserMention: true }),
      member('decision', { unreadCount: 1, hasUserMention: true }),
      member('new-b', { unreadCount: 4 }),
      member('new-c', { unreadCount: 5 }),
    ];
    const result = collapsedGroupPeek(members, new Set(['decision']));
    expect(result.total).toBe(5);
    expect(result.entries.map((entry) => [entry.member.id, entry.reason])).toEqual([
      ['decision', 'decision'],
      ['mention', 'mention'],
      ['new-a', 'unread'],
    ]);
  });
  it('removes a read mention from the next canonical projection without creating a new Group', () => {
    const before = member('mention', { unreadCount: 1, hasUserMention: true });
    expect(collapsedGroupPeek([before], new Set()).total).toBe(1);
    expect(collapsedGroupPeek([{ ...before, unreadCount: 0, hasUserMention: false }], new Set())).toEqual({
      entries: [],
      total: 0,
    });
  });
});
