import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { arrangeAttentionRows, buildAttentionClusters } from '../attention-clusters';
import { orderAttentionList } from '../attention-list-order';

function row(id: string, working = false): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    lastActiveAt: 1,
    pinned: true,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: 'default',
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: working ? 'working' : 'done' },
  };
}
const groups = [{ id: 'attention_g', threadIds: ['a', 'b', 'c', 'd'] }];
const modes = { 'group:attention_g': 'running-first' as const };
const arrange = (rows: SidebarSnapshotRow[], saved = groups) =>
  arrangeAttentionRows(rows, rows, buildAttentionClusters(rows, saved), 'pinned');
const members = (result: ReturnType<typeof orderAttentionList>) =>
  result.items.flatMap((item) => (item.kind === 'cluster' ? item.members : [])).map((member) => member.id);

describe('Group reading order lifecycle', () => {
  it('partitions multiple working members stably and retains the original manual ordering', () => {
    const input = arrange([row('a'), row('b', true), row('c'), row('d', true)]);
    expect(members(orderAttentionList(input, () => true, modes))).toEqual(['b', 'd', 'a', 'c']);
    expect(members(orderAttentionList(input, () => true, {}))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('never resurrects an unavailable member and honors a new explicit manual order', () => {
    const first = orderAttentionList(arrange([row('a'), row('b', true), row('c'), row('d')]), () => true, modes);
    const changed = arrange([row('a'), row('b'), row('d')], [{ id: 'attention_g', threadIds: ['d', 'b', 'a', 'c'] }]);
    const next = orderAttentionList(changed, () => true, modes, first.snapshot);
    expect(members(next)).toEqual(['d', 'b', 'a']);
    expect(
      next.items
        .flatMap((item) => (item.kind === 'cluster' ? item.members : []))
        .every((member) => member.presence.status === 'done'),
    ).toBe(true);
  });
  it('releases outer ordering only when the reading session closes and drops dissolved Groups', () => {
    const rows = [row('a'), row('b'), row('c'), row('d'), row('outside')];
    const first = orderAttentionList(arrange(rows), () => true, {});
    const reversed = arrange([...rows].reverse());
    const reading = orderAttentionList(reversed, () => true, {}, first.snapshot);
    expect(reading.snapshot.itemKeys).toEqual(first.snapshot.itemKeys);
    const closed = orderAttentionList(reversed, () => false, {}, reading.snapshot);
    expect(closed.snapshot.itemKeys).toEqual(['thread:outside', 'group:attention_g']);
    const dissolved = orderAttentionList(arrange(rows, []), () => true, modes, reading.snapshot);
    expect(dissolved.items.every((item) => item.kind === 'thread')).toBe(true);
    expect(dissolved.snapshot.openGroups).toEqual({});
  });
  it('retains existing positions when another row arrives while rendering its current facts', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const first = orderAttentionList(arrange(rows), () => true, modes);
    const next = orderAttentionList(
      arrange([row('new', true), ...rows.map((member) => ({ ...member, unreadCount: 4 }))]),
      () => true,
      modes,
      first.snapshot,
    );
    expect(next.snapshot.itemKeys).toEqual(['group:attention_g', 'thread:new']);
    expect(next.items[0]?.kind === 'cluster' && next.items[0].members[0]?.unreadCount).toBe(4);
  });
});
