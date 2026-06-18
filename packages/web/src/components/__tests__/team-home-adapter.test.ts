import type { BacklogItem, CatId } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { adaptTeamHomeData } from '../mission-control/team-home/adapter';

function catId(id: string): CatId {
  return id as CatId;
}

function makeBacklogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  const now = Date.UTC(2026, 5, 18, 9, 0, 0);
  return {
    id: 'backlog-f049',
    userId: 'u_test',
    title: '[F049] Mission Hub',
    summary: 'Mission Hub work',
    priority: 'p1',
    tags: ['source:docs-backlog', 'feature:f049'],
    status: 'dispatched',
    createdBy: 'user',
    createdAt: now - 10_000,
    updatedAt: now - 1_000,
    dispatchedAt: now - 5_000,
    dispatchedThreadId: 'thread-f049',
    dispatchedThreadPhase: 'coding',
    audit: [{ id: 'audit-dispatched', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
    ...overrides,
  };
}

describe('adaptTeamHomeData', () => {
  it('derives the active feature from docs backlog feature tags', () => {
    const data = adaptTeamHomeData({ items: [makeBacklogItem()] });

    expect(data.mission.activeFeatureId).toBe('F049');
    expect(data.mission.truthSourceUrl).toBe('/api/backlog/feature-doc-detail?featureId=F049');
  });

  it('projects active lease and thread state into the baton and team cards', () => {
    const acquiredAt = Date.UTC(2026, 5, 18, 9, 5, 0);
    const heartbeatAt = Date.UTC(2026, 5, 18, 9, 20, 0);
    const lastActiveAt = Date.UTC(2026, 5, 18, 9, 25, 0);
    const item = makeBacklogItem({
      title: 'Team Home MVP',
      lease: {
        ownerCatId: catId('codex'),
        state: 'active',
        acquiredAt,
        heartbeatAt,
        expiresAt: Date.UTC(2026, 5, 18, 10, 0, 0),
      },
    });

    const data = adaptTeamHomeData({
      items: [item],
      threadsByBacklogId: {
        [item.id]: {
          lastActiveAt,
          participants: [catId('codex'), catId('claude')],
        },
      },
    });

    expect(data.baton.holder).toBe('codex');
    expect(data.baton.scope).toBe('Team Home MVP');
    expect(data.baton.since).toBe(new Date(acquiredAt).toISOString());
    expect(data.baton.nextStep).toBe('@codex 正在实现中');

    expect(data.team.find((member) => member.id === 'codex')?.currentContext).toBe('持球：Team Home MVP');
    expect(data.team.find((member) => member.id === 'codex')?.lastActiveAt).toBe(new Date(lastActiveAt).toISOString());
    expect(data.team.find((member) => member.id === 'claude')?.currentContext).toBe('参与：Team Home MVP');
    expect(data.team.find((member) => member.id === 'claude')?.lastActiveAt).toBe(new Date(lastActiveAt).toISOString());
  });
});
