import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  type ArrangeLayout,
  captureArrangeLayout,
  moveArrangeThread,
  projectArrangeLayout,
} from '../attention-arrange-layout';
import { arrangeAttentionRows, buildAttentionClusters, flattenAttentionRows } from '../attention-clusters';

const row = (id: string, lastActiveAt: number): SidebarSnapshotRow => ({
  id,
  title: id,
  participants: [],
  lastActiveAt,
  pinned: false,
  favorited: false,
  labels: [],
  preferredCats: [],
  projectPath: '/fixture',
  systemKind: null,
  isHubThread: false,
  unreadCount: 0,
  hasUserMention: false,
  presence: { status: 'idle' },
});
const rows = [row('a', 50), row('b', 40), row('c', 30), row('d', 20), row('e', 10), row('incoming', 45)];
const group = (memberIds = ['a', 'b', 'c', 'd', 'e'], visibleCount = 4, expanded = true) => ({
  kind: 'group' as const,
  anchor: 'group:g',
  memberIds,
  visibleCount,
  expanded,
});
const saved = [{ id: 'g', threadIds: ['a', 'b', 'c', 'd', 'e', 'incoming'] }];
const ids = (layout: ArrangeLayout) =>
  layout.recent?.flatMap((item) => (item.kind === 'thread' ? [item.id] : item.memberIds));

describe('arrange membership deltas', () => {
  it.each(['move', 'create'] as const)('keeps cross-project %s membership inside each captured section', (action) => {
    const live = [row('a1', 50), row('a2', 40), row('b1', 30), row('b2', 20)].map((item) => ({
      ...item,
      projectPath: item.id.startsWith('a') ? '/A' : '/B',
    }));
    const beforeGroups = action === 'move' ? [{ id: 'g', threadIds: ['a1', 'a2'] }] : [];
    const beforeClusters = buildAttentionClusters(live, beforeGroups);
    const lists = Object.fromEntries(
      ['/A', '/B'].map((key) => {
        const scoped = live.filter((item) => item.projectPath === key);
        return [
          key,
          flattenAttentionRows(arrangeAttentionRows(scoped, scoped, beforeClusters, 'project'), () => true, ''),
        ];
      }),
    );
    const layout = captureArrangeLayout(lists, lists);
    const after = [{ id: 'g', threadIds: action === 'move' ? ['a1', 'a2', 'b1'] : ['a1', 'b1'] }];
    const next = moveArrangeThread(layout, 'b1', after, {}, live);
    const projected = projectArrangeLayout(next, live, buildAttentionClusters(live, after));
    const idsBySection = Object.fromEntries(
      Object.entries(projected).map(([key, items]) => [
        key,
        items.flatMap((item) =>
          item.kind === 'thread' ? [item.thread.id] : item.kind === 'cluster-member' ? [item.member.id] : [],
        ),
      ]),
    );
    expect(idsBySection).toEqual({ '/A': ['a1', 'a2'], '/B': ['b1', 'b2'] });
    expect(next['/A']).toEqual(layout['/A']);
  });

  it('forms the destination group only with members from the source project and dissolves its old local shell', () => {
    const layout: ArrangeLayout = {
      '/A': [{ ...group(['a', 'b'], 2), anchor: 'group:destination' }],
      '/B': [
        { ...group(['incoming', 'd'], 2), anchor: 'group:source' },
        { kind: 'thread', id: 'e' },
      ],
    };
    const groups = [
      { id: 'destination', threadIds: ['a', 'b', 'e', 'incoming'] },
      { id: 'source', threadIds: ['d', 'c'] },
    ];
    const result = moveArrangeThread(layout, 'incoming', groups, {}, rows);
    expect(result['/A']).toEqual(layout['/A']);
    expect(result['/B']).toEqual([
      { kind: 'thread', id: 'd' },
      { ...group(['incoming', 'e'], 2), anchor: 'group:destination' },
    ]);
  });
  it.each([
    [45, 5, ['a', 'incoming', 'b', 'c', 'd']],
    [1, 4, ['a', 'b', 'c', 'd']],
  ] as const)('inserts incoming activity %s without displacing visible members', (activity, count, visible) => {
    const layout: ArrangeLayout = { recent: [group(), { kind: 'thread', id: 'incoming' }] };
    const snapshot = structuredClone(layout);
    const live = rows.map((item) => (item.id === 'incoming' ? { ...item, lastActiveAt: activity } : item));
    const result = moveArrangeThread(layout, 'incoming', saved, {}, live);
    expect(layout).toEqual(snapshot);
    expect(result.recent?.[0]).toMatchObject({ visibleCount: count });
    const rendered = projectArrangeLayout(result, live, buildAttentionClusters(live, saved)).recent ?? [];
    expect(rendered.flatMap((item) => (item.kind === 'cluster-member' ? [item.member.id] : []))).toEqual(visible);
    expect(rendered.find((item) => item.kind === 'cluster-remainder')).toMatchObject({ remainingCount: 6 - count });
  });

  it('keeps an incoming last row visible when the group had no remainder', () => {
    const layout: ArrangeLayout = { recent: [group(['a', 'b'], 2), { kind: 'thread', id: 'incoming' }] };
    expect(
      moveArrangeThread(layout, 'incoming', [{ id: 'g', threadIds: ['a', 'b', 'incoming'] }], {}, rows).recent?.[0],
    ).toMatchObject({ visibleCount: 3 });
  });

  it('keeps a collapsed destination collapsed and does not re-sort existing rows', () => {
    const layout: ArrangeLayout = { recent: [group(['c', 'a', 'b'], 0, false), { kind: 'thread', id: 'incoming' }] };
    const result = moveArrangeThread(
      layout,
      'incoming',
      [{ id: 'g', threadIds: ['c', 'a', 'b', 'incoming'] }],
      {},
      rows,
    );
    expect(result.recent?.[0]).toMatchObject({ expanded: false, memberIds: ['incoming', 'c', 'a', 'b'] });
  });

  it('honors persisted manual order, including a pinned row in second place', () => {
    const layout: ArrangeLayout = { recent: [group(['a', 'b', 'c'], 3)] };
    const live = rows.map((item) => ({ ...item, pinned: item.id === 'a' }));
    const result = moveArrangeThread(
      layout,
      'a',
      [{ id: 'g', threadIds: ['b', 'a', 'c'] }],
      { 'group:g': 'manual' },
      live,
    );
    expect(ids(result)).toEqual(['b', 'a', 'c']);
    expect(result.recent?.[0]).toMatchObject({ visibleCount: 3 });
  });

  it('replaces only the target standalone when creating a group', () => {
    const layout: ArrangeLayout = {
      recent: [
        { kind: 'thread', id: 'a' },
        { kind: 'thread', id: 'b' },
        { kind: 'thread', id: 'incoming' },
      ],
    };
    const result = moveArrangeThread(layout, 'incoming', [{ id: 'g', threadIds: ['b', 'incoming'] }], {}, rows);
    expect(result.recent).toEqual([{ kind: 'thread', id: 'a' }, group(['incoming', 'b'], 2)]);
  });

  it('dissolves the source shell in place and removes to immediately after that block', () => {
    const layout: ArrangeLayout = { recent: [group(['a', 'b'], 2), { kind: 'thread', id: 'c' }] };
    expect(moveArrangeThread(layout, 'a', [], {}, rows).recent).toEqual([
      { kind: 'thread', id: 'b' },
      { kind: 'thread', id: 'a' },
      { kind: 'thread', id: 'c' },
    ]);
  });

  it('moves between groups while retaining unrelated outer order', () => {
    const layout: ArrangeLayout = {
      recent: [
        group(['a', 'incoming'], 2),
        { kind: 'thread', id: 'e' },
        { ...group(['b', 'c'], 2), anchor: 'group:h' },
      ],
    };
    const result = moveArrangeThread(layout, 'incoming', [{ id: 'h', threadIds: ['b', 'c', 'incoming'] }], {}, rows);
    expect(result.recent).toEqual([
      { kind: 'thread', id: 'a' },
      { kind: 'thread', id: 'e' },
      { ...group(['incoming', 'b', 'c'], 3), anchor: 'group:h' },
    ]);
  });
});
