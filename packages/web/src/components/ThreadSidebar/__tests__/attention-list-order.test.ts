import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { arrangeAttentionRows, buildAttentionClusters } from '../attention-clusters';
import { attentionItemKey, orderAttentionList } from '../attention-list-order';
import { buildSidebarTabContent } from '../thread-utils';

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
  describe.each(['thread', 'closed Group'] as const)('outside %s working-order refinements', (kind) => {
    it.each([
      ['missing to known', undefined, 50],
      ['known to earlier', 150, 50],
      ['known to later', 50, 150],
      ['known to missing', 50, undefined],
    ] as const)('applies canonical ordering for %s without closing the reading Group', (_, before, after) => {
      const saved = kind === 'thread' ? groups : [...groups, { id: 'second', threadIds: ['x', 'y'] }];
      const outsideKey = kind === 'thread' ? 'thread:x' : 'group:second';
      const isOpen = (cluster: { anchor: string }) => cluster.anchor === 'group:attention_g';
      const input = (start: number | undefined) => {
        const rows = [row('a', true), row('b'), row('c'), row('d'), row('x', true), row('y')].map((member) => ({
          ...member,
          presence: {
            ...member.presence,
            activeSince: member.id === 'a' ? 100 : member.id === 'x' ? start : undefined,
          },
        }));
        return arrange(buildSidebarTabContent('pinned', rows).threads, saved);
      };
      const first = orderAttentionList(input(before), isOpen, modes);
      const sorted = input(after);
      const next = orderAttentionList(sorted, isOpen, modes, first.snapshot);
      expect(sorted.map(attentionItemKey).slice(0, 2)).toEqual(
        after === 50 ? [outsideKey, 'group:attention_g'] : ['group:attention_g', outsideKey],
      );
      expect(next.items.map(attentionItemKey)).toEqual(sorted.map(attentionItemKey));
      expect(next.snapshot.openGroups).toEqual(first.snapshot.openGroups);
    });
  });

  it('keeps the open Group placement when only its own working start is refined', () => {
    const isOpen = (cluster: { anchor: string }) => cluster.anchor === 'group:attention_g';
    const input = (start: number | undefined) => {
      const rows = [row('a', true), row('b'), row('c'), row('d'), row('outside', true)].map((member) => ({
        ...member,
        presence: { ...member.presence, activeSince: member.id === 'outside' ? 100 : start },
      }));
      return arrange(buildSidebarTabContent('pinned', rows).threads);
    };
    const first = orderAttentionList(input(undefined), isOpen, modes);
    expect(first.snapshot.itemKeys).toEqual(['thread:outside', 'group:attention_g']);
    const canonical = input(50);
    expect(canonical.map(attentionItemKey)).toEqual(['group:attention_g', 'thread:outside']);
    const next = orderAttentionList(canonical, isOpen, modes, first.snapshot);
    expect(next.snapshot.itemKeys).toEqual(first.snapshot.itemKeys);
    expect(members(next)).toEqual(members(first));
    expect(next.items[1]?.kind === 'cluster' && next.items[1].members[0]?.presence.activeSince).toBe(50);
  });

  it('releases placement when a closed Group changes its working member', () => {
    const saved = [...groups, { id: 'second', threadIds: ['x', 'y'] }];
    const isOpen = (cluster: { anchor: string }) => cluster.anchor === 'group:attention_g';
    const input = (working: string) => {
      const rows = [
        row('a', true),
        row('b'),
        row('c'),
        row('d'),
        row('x', working === 'x'),
        row('y', working === 'y'),
      ].map((member) => ({
        ...member,
        presence: { ...member.presence, activeSince: member.id === 'a' ? 100 : member.id === 'x' ? 150 : 50 },
      }));
      return arrange(buildSidebarTabContent('pinned', rows).threads, saved);
    };
    const first = orderAttentionList(input('x'), isOpen, modes);
    expect(first.snapshot.itemKeys).toEqual(['group:attention_g', 'group:second']);
    const next = orderAttentionList(input('y'), isOpen, modes, first.snapshot);
    expect(next.snapshot.itemKeys).toEqual(['group:second', 'group:attention_g']);
    expect(next.snapshot.openGroups).toEqual(first.snapshot.openGroups);
  });

  it('promotes an outside working thread while an unrelated Group stays open', () => {
    const rows = [row('a'), row('b'), row('c'), row('d'), row('idle'), row('outside')];
    const first = orderAttentionList(arrange(rows), () => true, modes);
    const updated = rows.map((member) => (member.id === 'outside' ? row('outside', true) : member));
    const sorted = arrange(buildSidebarTabContent('pinned', updated).threads);
    expect(sorted.map(attentionItemKey)[0]).toBe('thread:outside');
    const next = orderAttentionList(sorted, () => true, modes, first.snapshot);
    expect(next.items.map(attentionItemKey)).toEqual(sorted.map(attentionItemKey));
    expect(members(next)).toEqual(members(first));
    expect(next.snapshot.openGroups['group:attention_g']).toBeDefined();
  });

  it('promotes a closed Group that starts working without reopening the unrelated reading Group', () => {
    const saved = [...groups, { id: 'second', threadIds: ['x', 'y'] }];
    const rows = [row('a'), row('b'), row('c'), row('d'), row('idle'), row('x'), row('y')];
    const isOpen = (cluster: { anchor: string }) => cluster.anchor === 'group:attention_g';
    const first = orderAttentionList(arrange(rows, saved), isOpen, modes);
    const updated = rows.map((member) => (member.id === 'y' ? row('y', true) : member));
    const sorted = arrange(buildSidebarTabContent('pinned', updated).threads, saved);
    const next = orderAttentionList(sorted, isOpen, modes, first.snapshot);
    expect(next.items.map(attentionItemKey)).toEqual(sorted.map(attentionItemKey));
    expect(next.items[0]?.kind === 'cluster' && next.items[0].cluster.groupId).toBe('second');
  });
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
  it('admits newly arrived working rows while retaining the open member order and current facts', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')];
    const first = orderAttentionList(arrange(rows), () => true, modes);
    const next = orderAttentionList(
      arrange([row('new', true), ...rows.map((member) => ({ ...member, unreadCount: 4 }))]),
      () => true,
      modes,
      first.snapshot,
    );
    expect(next.snapshot.itemKeys).toEqual(['thread:new', 'group:attention_g']);
    expect(next.items[1]?.kind === 'cluster' && next.items[1].members[0]?.unreadCount).toBe(4);
  });
});
