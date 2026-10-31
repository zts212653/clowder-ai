import { describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { arrangeAttentionRows, buildAttentionClusters, resolveAttentionClusterOpen } from '../attention-clusters';

function row(id: string, overrides: Partial<SidebarSnapshotRow> = {}): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    lastActiveAt: 1,
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: 'default',
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...overrides,
  };
}

describe('F277 attention cluster composition', () => {
  it('treats explicit conversation groups as the only visible membership truth', () => {
    const rows = [row('parent'), row('child'), row('manual-peer')];
    const clusters = buildAttentionClusters(rows, [
      {
        id: 'attention_f277',
        name: 'F277 收口',
        threadIds: ['child', 'manual-peer'],
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      anchor: 'group:attention_f277',
      groupId: 'attention_f277',
      title: 'F277 收口',
      memberIds: ['child', 'manual-peer'],
    });
    expect(clusters[0]?.memberIds).not.toContain('parent');
  });

  it('keeps exact relations ungrouped until the owner explicitly creates a Group', () => {
    const rows = [row('parent'), row('child'), row('grandchild'), row('standalone')];
    expect(buildAttentionClusters(rows)).toEqual([]);
  });

  it('never creates membership from matching titles', () => {
    const rows = [row('one', { title: 'F296 same title' }), row('two', { title: 'F296 same title' })];
    expect(buildAttentionClusters(rows)).toEqual([]);
  });

  it('lets a pinned member bring the full explicit Group closure into the pinned view', () => {
    const allRows = [row('parent'), row('child', { pinned: true }), row('grandchild'), row('other', { pinned: true })];
    const clusters = buildAttentionClusters(allRows, [
      { id: 'attention_chain', threadIds: ['parent', 'child', 'grandchild'] },
    ]);
    const arranged = arrangeAttentionRows(
      allRows.filter((candidate) => candidate.pinned),
      allRows,
      clusters,
      'pinned',
    );

    expect(arranged.map((item) => item.kind)).toEqual(['cluster', 'thread']);
    expect(arranged[0]?.kind === 'cluster' ? arranged[0].members.map((member) => member.id) : []).toEqual([
      'parent',
      'child',
      'grandchild',
    ]);
  });

  it('pairs current/search auto-open with a reversible user override', () => {
    const cluster = buildAttentionClusters(
      [row('parent'), row('child')],
      [{ id: 'attention_pair', threadIds: ['parent', 'child'] }],
    )[0];
    expect(cluster).toBeDefined();
    if (!cluster) return;
    expect(resolveAttentionClusterOpen(cluster, {}, 'child', '')).toBe(true);
    expect(resolveAttentionClusterOpen(cluster, { [cluster.anchor]: false }, 'child', '')).toBe(false);
    expect(resolveAttentionClusterOpen(cluster, { [cluster.anchor]: false }, 'other', 'parent')).toBe(true);
    expect(resolveAttentionClusterOpen(cluster, { [cluster.anchor]: false }, 'other', '')).toBe(false);
  });
});
