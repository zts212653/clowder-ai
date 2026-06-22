import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NOW = Date.parse('2026-06-19T12:00:00.000Z');

function baseIssue(overrides = {}) {
  return {
    id: 'issue-acme-repo-1',
    repo: 'acme/repo',
    issueNumber: 1,
    issueType: 'feature',
    title: 'Support queue mode',
    state: 'unreplied',
    replyState: 'unreplied',
    assignedThreadId: null,
    assignedCatId: 'opus',
    directionCard: null,
    closureChecklist: undefined,
    closureWaiver: null,
    projectionState: undefined,
    nextOwner: undefined,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function narratorDirectionCard(narrative, routeRecommendation = { kind: 'new-thread' }) {
  return {
    entries: [
      {
        catId: 'opus',
        authoredByRole: 'narrator',
        routeRecommendation,
        narrative,
        timestamp: NOW - 90_000,
      },
    ],
  };
}

function peerDirectionCard(narrative) {
  return {
    entries: [
      {
        catId: 'opus',
        routeRecommendation: { kind: 'new-thread' },
        narrative,
        timestamp: NOW - 80_000,
      },
    ],
  };
}

describe('buildCommunityDecisionQueue direction decisions', () => {
  test('pending-decision issue with narrator entry produces direction-decision item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-1',
          issueNumber: 1,
          state: 'pending-decision',
          directionCard: narratorDirectionCard('This needs a decision.'),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'direction-decision');
    assert.equal(queue[0].priority, 'high');
    assert.equal(queue[0].actor, 'cvo');
    assert.equal(queue[0].recommendedActions[0].kind, 'resolve-direction');
    assert.match(queue[0].ask, /direction/i);
  });

  test('triaged projection does not hide legacy pending-decision issue', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-bootstrap-triaged',
          issueNumber: 11,
          state: 'pending-decision',
          projectionState: 'triaged',
          directionCard: narratorDirectionCard('Bootstrap projection should not hide this decision.'),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'direction-decision');
    assert.equal(queue[0].source.projectionState, 'triaged');
  });

  test('direction-decision item carries validated routeRecommendation for the accept action', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-existing-thread',
          issueNumber: 16,
          assignedCatId: 'codex',
          state: 'pending-decision',
          directionCard: narratorDirectionCard('Route to the known owner thread.', {
            kind: 'existing-thread',
            threadId: 'thread-owner',
            ignored: 'stripped',
          }),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.deepEqual(queue[0].source.routeRecommendation, {
      kind: 'existing-thread',
      threadId: 'thread-owner',
    });
    assert.equal(queue[0].source.catId, 'opus');
    assert.equal(queue[0].source.assignedCatId, 'codex');
  });

  test('direction-decision item exposes the owner thread jump when routed', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-existing-thread',
          issueNumber: 16,
          assignedThreadId: 'thread-owner',
          state: 'pending-decision',
          directionCard: narratorDirectionCard('Route to the known owner thread.', {
            kind: 'existing-thread',
            threadId: 'thread-owner',
          }),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].source.assignedThreadId, 'thread-owner');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['open-thread', 'resolve-direction'],
    );
    assert.equal(queue[0].recommendedActions[0].threadId, 'thread-owner');
  });

  test('direction-decision item exposes the recommended owner thread before routing', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-recommended-existing-thread',
          issueNumber: 17,
          state: 'pending-decision',
          directionCard: narratorDirectionCard('Route to the known owner thread before acceptance.', {
            kind: 'existing-thread',
            threadId: 'thread-owner',
          }),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].source.assignedThreadId, 'thread-owner');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['open-thread', 'resolve-direction'],
    );
    assert.equal(queue[0].recommendedActions[0].threadId, 'thread-owner');
  });

  test('direction-decision item prefers recommended owner thread over stale mapped thread', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-stale-triage-thread',
          issueNumber: 18,
          assignedThreadId: 'thread-triage',
          state: 'pending-decision',
          directionCard: narratorDirectionCard('Route away from the stale triage thread.', {
            kind: 'existing-thread',
            threadId: 'thread-owner',
          }),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].source.assignedThreadId, 'thread-owner');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['open-thread', 'resolve-direction'],
    );
    assert.equal(queue[0].recommendedActions[0].threadId, 'thread-owner');
  });

  test('pending-decision issue with non-narrator direction entry still produces direction item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-peer-triage',
          issueNumber: 15,
          state: 'pending-decision',
          directionCard: peerDirectionCard('Two triage cats disagreed; operator must decide.'),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'direction-decision');
    assert.equal(queue[0].why, 'Two triage cats disagreed; operator must decide.');
    assert.equal(queue[0].source.directionCardEntryId, undefined);
  });

  test('terminal projection suppresses stale legacy direction card', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-1',
          issueNumber: 1,
          state: 'pending-decision',
          projectionState: 'closed',
          directionCard: narratorDirectionCard('This stale decision should not reappear.'),
          closureChecklist: {
            readyToClose: true,
            waiverPresent: false,
            blockers: [],
          },
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 0);
  });

  test('advanced projection suppresses stale legacy direction card', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-advanced',
          issueNumber: 12,
          state: 'pending-decision',
          projectionState: 'fixed',
          directionCard: narratorDirectionCard('This stale direction should not reappear after projection advanced.'),
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 0);
  });

  test('malformed non-array direction entries are ignored', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-malformed',
          issueNumber: 13,
          state: 'pending-decision',
          directionCard: { entries: { authoredByRole: 'narrator' } },
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 0);
  });

  test('non-object direction entries are skipped', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-mixed',
          issueNumber: 14,
          state: 'pending-decision',
          directionCard: {
            entries: [null, 'bad', { authoredByRole: 'narrator', narrative: 'Valid entry', timestamp: NOW - 90_000 }],
          },
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'direction-decision');
  });
});
