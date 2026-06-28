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

function baseFinding(overrides = {}) {
  return {
    findingId: 'finding-1',
    subjectKey: 'issue:acme/repo#1',
    findingKind: 'github-reopened-case-closed',
    severity: 'warning',
    message: 'GitHub issue was reopened but case was closed.',
    status: 'open',
    waiver: null,
    evidenceFingerprint: 'sha-1',
    createdAt: NOW - 600_000,
    updatedAt: NOW - 120_000,
    ...overrides,
  };
}

describe('buildCommunityDecisionQueue', () => {
  test('fixed issue with fixed-not-reported blocker produces closure-action item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-2',
          issueNumber: 2,
          state: 'closed',
          projectionState: 'fixed',
          closureChecklist: {
            readyToClose: false,
            waiverPresent: false,
            blockers: [{ kind: 'fixed-not-reported', detail: 'Needs public reply' }],
          },
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'closure-action');
    assert.equal(queue[0].priority, 'high');
    assert.equal(queue[0].actor, 'case-owner');
    assert.equal(queue[0].source.assignedCatId, 'opus');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['mark-reported', 'waive-closure'],
    );
  });

  test('ready-to-close issue produces close-via-github closure-action item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-3',
          issueNumber: 3,
          state: 'fixed',
          projectionState: 'reported',
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

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'closure-action');
    assert.equal(queue[0].priority, 'high');
    assert.equal(queue[0].actor, 'case-owner');
    assert.equal(queue[0].source.assignedCatId, 'opus');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['close-via-github'],
    );
    assert.equal(queue[0].recommendedActions[0].endpoint, 'https://github.com/acme/repo/issues/3');
  });

  test('actionable issue queue items include the owner thread jump', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-3',
          issueNumber: 3,
          assignedThreadId: 'thread-owner',
          state: 'fixed',
          projectionState: 'reported',
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

    assert.equal(queue.length, 1);
    assert.equal(queue[0].source.assignedThreadId, 'thread-owner');
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['open-thread', 'close-via-github'],
    );
    assert.equal(queue[0].recommendedActions[0].threadId, 'thread-owner');
  });

  test('projection-only ready-to-close issue still produces close-via-github action', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'projection-only-issue-4',
          issueNumber: 4,
          state: 'fixed',
          projectionState: 'reported',
          closureActionsAvailable: false,
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

    assert.equal(queue.length, 1);
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['close-via-github'],
    );
  });

  test('fixed PR blocker without clearing endpoint produces no closure-action item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [],
      prItems: [
        {
          taskId: 'pr-2',
          prNumber: 2,
          title: 'Fix plugin lifecycle',
          state: 'fixed',
          closureChecklist: {
            readyToClose: false,
            waiverPresent: false,
            blockers: [{ kind: 'fixed-not-reported', detail: 'Needs public reply' }],
          },
          projectionState: 'fixed',
          nextOwner: 'case-owner',
          updatedAt: NOW - 60_000,
        },
      ],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 0);
  });

  test('ready-to-close PR produces close-via-github closure-action item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [],
      prItems: [
        {
          taskId: 'pr-5',
          prNumber: 5,
          title: 'Fix queue contract',
          state: 'fixed',
          closureChecklist: {
            readyToClose: true,
            waiverPresent: false,
            blockers: [],
          },
          projectionState: 'reported',
          nextOwner: 'case-owner',
          updatedAt: NOW - 60_000,
        },
      ],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].subjectType, 'pr');
    assert.equal(queue[0].number, 5);
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['close-via-github'],
    );
    assert.equal(queue[0].recommendedActions[0].endpoint, 'https://github.com/acme/repo/pull/5');
  });

  test('non-closeable checklist blocker on pending-decision does not create closure queue noise', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          issueNumber: 6,
          state: 'pending-decision',
          directionCard: {
            entries: [{ authoredByRole: 'narrator', routeRecommendation: { kind: 'new-thread' }, timestamp: NOW }],
          },
          closureChecklist: {
            readyToClose: false,
            waiverPresent: false,
            blockers: [{ kind: 'not-in-closeable-state', detail: 'Not closeable yet' }],
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

  test('closed clean projection produces no queue item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          issueNumber: 8,
          state: 'closed',
          projectionState: 'closed',
          closureChecklist: { readyToClose: true, waiverPresent: false, blockers: [] },
        }),
      ],
      prItems: [],
      findings: [],
      now: NOW,
    });

    assert.equal(queue.length, 0);
  });

  test('sorts by priority, actor, updatedAt desc, then id asc', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          id: 'issue-low',
          issueNumber: 9,
          state: 'pending-decision',
          updatedAt: NOW - 10,
          directionCard: {
            entries: [{ authoredByRole: 'narrator', routeRecommendation: { kind: 'new-thread' }, timestamp: NOW }],
          },
        }),
      ],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#10:github-reopened-case-closed',
          subjectKey: 'issue:acme/repo#10',
          findingKind: 'github-reopened-case-closed',
          updatedAt: NOW - 100,
        }),
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#11:github-closed-case-open',
          subjectKey: 'issue:acme/repo#11',
          findingKind: 'github-closed-case-open',
          updatedAt: NOW - 50,
        }),
      ],
      now: NOW,
    });

    assert.deepEqual(
      queue.map((item) => item.id),
      [
        'decision:reconciliation-finding:issue:acme/repo#11:reconcile:issue:acme/repo#11:github-closed-case-open',
        'decision:reconciliation-finding:issue:acme/repo#10:reconcile:issue:acme/repo#10:github-reopened-case-closed',
        'decision:direction-decision:issue:acme/repo#9:issue-low',
      ],
    );
  });

  test('finding queue items inherit the subject owner thread jump', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [baseIssue({ issueNumber: 10, assignedThreadId: 'thread-finding' })],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#10:github-reopened-case-closed',
          subjectKey: 'issue:acme/repo#10',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.deepEqual(
      queue[0].recommendedActions.map((a) => a.kind),
      ['open-thread', 'acknowledge-finding', 'resolve-finding', 'waive-finding'],
    );
    assert.equal(queue[0].recommendedActions[0].threadId, 'thread-finding');
  });
});
