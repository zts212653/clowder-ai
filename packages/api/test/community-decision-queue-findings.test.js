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

describe('buildCommunityDecisionQueue finding items', () => {
  test('case-fixed-unreported finding produces SLA dead-letter item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [baseIssue({ issueNumber: 3 })],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'sla:issue:acme/repo#3:case-fixed-unreported',
          subjectKey: 'issue:acme/repo#3',
          findingKind: 'case-fixed-unreported',
          message: 'Fixed for 8d without report.',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'sla-dead-letter');
    assert.equal(queue[0].priority, 'urgent');
    assert.equal(queue[0].source.findingId, 'sla:issue:acme/repo#3:case-fixed-unreported');
  });

  test('github-reopened-case-closed finding produces urgent reconciliation-finding item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [baseIssue({ issueNumber: 4 })],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#4:github-reopened-case-closed',
          subjectKey: 'issue:acme/repo#4',
          findingKind: 'github-reopened-case-closed',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'reconciliation-finding');
    assert.equal(queue[0].priority, 'urgent');
  });

  test('case-closed-github-open finding produces urgent reconciliation-finding item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [baseIssue({ issueNumber: 12 })],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#12:case-closed-github-open',
          subjectKey: 'issue:acme/repo#12',
          findingKind: 'case-closed-github-open',
          message: 'Case is closed but GitHub is still open.',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'reconciliation-finding');
    assert.equal(queue[0].priority, 'urgent');
  });

  test('stale-awaiting-external finding produces external-followup item', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [baseIssue({ issueNumber: 5 })],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'sla:issue:acme/repo#5:stale-awaiting-external',
          subjectKey: 'issue:acme/repo#5',
          findingKind: 'stale-awaiting-external',
          message: 'Awaiting external for 15d.',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'external-followup');
    assert.equal(queue[0].priority, 'normal');
    assert.equal(queue[0].actor, 'case-owner');
  });

  test('stale PR external finding uses PR label in ask text', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'sla:pr:acme/repo#5:stale-awaiting-external',
          subjectKey: 'pr:acme/repo#5',
          findingKind: 'stale-awaiting-external',
          message: 'PR is awaiting external follow-up.',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 1);
    assert.equal(queue[0].kind, 'external-followup');
    assert.equal(queue[0].subjectType, 'pr');
    assert.match(queue[0].ask, /PR #5/);
    assert.doesNotMatch(queue[0].ask, /issue #5/);
  });

  test('acknowledged urgent finding is demoted below open normal follow-up', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'reconcile:issue:acme/repo#6:github-reopened-case-closed',
          subjectKey: 'issue:acme/repo#6',
          findingKind: 'github-reopened-case-closed',
          status: 'acknowledged',
          updatedAt: NOW,
        }),
        baseFinding({
          findingId: 'sla:issue:acme/repo#7:stale-awaiting-external',
          subjectKey: 'issue:acme/repo#7',
          findingKind: 'stale-awaiting-external',
          updatedAt: NOW - 100,
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 2);
    assert.equal(queue[0].priority, 'normal');
    assert.equal(queue[0].kind, 'external-followup');
    assert.equal(queue[1].priority, 'low');
    assert.equal(queue[1].source.findingId, 'reconcile:issue:acme/repo#6:github-reopened-case-closed');
  });

  test('same subject preserves closure action and SLA finding action groups', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          issueNumber: 7,
          projectionState: 'fixed',
          closureChecklist: {
            readyToClose: false,
            waiverPresent: false,
            blockers: [{ kind: 'fixed-not-reported', detail: 'Needs public reply' }],
          },
        }),
      ],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'sla:issue:acme/repo#7:case-fixed-unreported',
          subjectKey: 'issue:acme/repo#7',
          findingKind: 'case-fixed-unreported',
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 2);
    assert.deepEqual(
      queue.map((item) => [item.kind, item.priority, item.recommendedActions.map((action) => action.kind)]),
      [
        ['sla-dead-letter', 'urgent', ['acknowledge-finding', 'resolve-finding', 'waive-finding']],
        ['closure-action', 'high', ['mark-reported', 'waive-closure']],
      ],
    );
  });

  test('same subject preserves distinct operator and case-owner actions', async () => {
    const { buildCommunityDecisionQueue } = await import('../dist/domains/community/community-decision-queue.js');

    const queue = buildCommunityDecisionQueue({
      repo: 'acme/repo',
      issues: [
        baseIssue({
          issueNumber: 12,
          state: 'pending-decision',
          directionCard: {
            entries: [
              {
                authoredByRole: 'narrator',
                routeRecommendation: { kind: 'new-thread' },
                narrative: 'Needs operator routing.',
                timestamp: NOW - 50,
              },
            ],
          },
        }),
      ],
      prItems: [],
      findings: [
        baseFinding({
          findingId: 'sla:issue:acme/repo#12:stale-awaiting-external',
          subjectKey: 'issue:acme/repo#12',
          findingKind: 'stale-awaiting-external',
          updatedAt: NOW - 100,
        }),
      ],
      now: NOW,
    });

    assert.equal(queue.length, 2);
    assert.deepEqual(
      queue.map((item) => [item.kind, item.actor]),
      [
        ['direction-decision', 'cvo'],
        ['external-followup', 'case-owner'],
      ],
    );
  });
});
