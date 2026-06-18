import type { BacklogItem, CatId } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { adaptTeamHomeData } from '../mission-control/team-home/adapter';
import { teamHomeFixture } from '../mission-control/team-home/fixture';

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

  it('does not treat audit lifecycle logs as evidence items', () => {
    const data = adaptTeamHomeData({
      items: [
        makeBacklogItem({
          audit: [
            { id: 'audit-created', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: 1 },
            { id: 'audit-dispatched', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: 2 },
            { id: 'audit-heartbeat', action: 'lease_heartbeat', actor: { kind: 'cat', id: 'codex' }, timestamp: 3 },
          ],
        }),
      ],
    });

    expect(data.missions[0]?.evidenceCount).toBeUndefined();
    expect(data.missions[0]?.requiredEvidence).toBeUndefined();
  });

  it('only treats approved or dispatched items as active work', () => {
    const suggested = makeBacklogItem({ id: 'suggested-1', status: 'suggested' });
    const done = makeBacklogItem({ id: 'done-1', status: 'done' });
    const data = adaptTeamHomeData({ items: [suggested, done] });

    expect(data.missions).toHaveLength(0);
    expect(data.baton.scope).toBe(teamHomeFixture.baton.scope);
    expect(data.mission.activeFeatureId).toBe('—');
  });
});
