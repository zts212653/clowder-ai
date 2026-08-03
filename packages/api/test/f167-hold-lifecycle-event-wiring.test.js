/**
 * F167 Phase Q — structured event callbacks retire matching hold timers.
 *
 * These tests exercise the event-source TaskSpec execute path directly. The
 * matching/cancel mechanics are covered in hold-ball-cancel.test.js; this file
 * pins the missing wiring from event delivery → hold retirement.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const log = {
  info() {},
  error() {},
  warn() {},
};

describe('F167 Phase Q: event-source hold retirement wiring', () => {
  test('ReviewFeedbackTaskSpec retires review_posted holds after notifying and committing cursor', async () => {
    const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
    const retired = [];
    let cursorCommitted = false;

    const spec = createReviewFeedbackTaskSpec({
      taskStore: {},
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        async route() {
          return {
            kind: 'notified',
            threadId: 'thread-Q',
            catId: 'codex',
            messageId: 'msg-review-1',
            content: 'review arrived',
          };
        },
      },
      holdLifecycle: {
        retireSatisfiedWait(event) {
          retired.push(event);
          return [];
        },
      },
      log,
    });

    await spec.run.execute(
      {
        repairedTask: {
          id: 'task-pr-1',
          kind: 'pr_tracking',
          title: 'PR #42',
          status: 'doing',
          threadId: 'thread-Q',
          ownerCatId: 'codex',
          userId: 'user1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subjectKey: 'pr:owner/repo#42',
        },
        repoFullName: 'owner/repo',
        prNumber: 42,
        newComments: [{ id: 1001, author: 'reviewer', body: 'fix', createdAt: new Date().toISOString() }],
        newDecisions: [],
        commitCursor: async () => {
          cursorCommitted = true;
        },
      },
      'pr:owner/repo#42',
      {},
    );

    assert.equal(cursorCommitted, true);
    assert.deepEqual(retired, [
      {
        threadId: 'thread-Q',
        subjectKey: 'pr:owner/repo#42',
        expectedSignalKey: 'review_posted',
        sourceKind: 'review_feedback',
        sourceMessageId: 'msg-review-1',
      },
    ]);
  });

  test('CiCdCheckTaskSpec retires ci_complete holds after CI notification', async () => {
    const { createCiCdCheckTaskSpec } = await import('../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const retired = [];

    const spec = createCiCdCheckTaskSpec({
      taskStore: {},
      cicdRouter: {
        async route() {
          return {
            kind: 'notified',
            threadId: 'thread-Q',
            catId: 'codex',
            messageId: 'msg-ci-1',
            bucket: 'pass',
            content: 'CI passed',
          };
        },
      },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 42,
        headSha: 'abc1234',
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      }),
      invokeTrigger: {
        async trigger() {},
      },
      holdLifecycle: {
        retireSatisfiedWait(event) {
          retired.push(event);
          return [];
        },
      },
      log,
    });

    await spec.run.execute(
      {
        task: {
          id: 'task-pr-1',
          kind: 'pr_tracking',
          title: 'PR #42',
          status: 'doing',
          threadId: 'thread-Q',
          ownerCatId: 'codex',
          userId: 'user1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subjectKey: 'pr:owner/repo#42',
          automationState: { intent: 'merge' },
        },
        repoFullName: 'owner/repo',
        prNumber: 42,
      },
      'pr:owner/repo#42',
      {},
    );

    assert.deepEqual(retired, [
      {
        threadId: 'thread-Q',
        subjectKey: 'pr:owner/repo#42',
        expectedSignalKey: 'ci_complete',
        sourceKind: 'ci_check',
        sourceMessageId: 'msg-ci-1',
      },
    ]);
  });

  test('CiCdCheckTaskSpec leaves ci_complete holds active for silent review-intent CI pass', async () => {
    const { createCiCdCheckTaskSpec } = await import('../dist/infrastructure/email/CiCdCheckTaskSpec.js');
    const retired = [];
    const triggers = [];

    const spec = createCiCdCheckTaskSpec({
      taskStore: {},
      cicdRouter: {
        async route() {
          return {
            kind: 'notified',
            threadId: 'thread-Q',
            catId: 'codex',
            messageId: 'msg-ci-review-pass',
            bucket: 'pass',
            content: 'CI passed',
          };
        },
      },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 42,
        headSha: 'abc1234',
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      }),
      invokeTrigger: {
        async trigger(...args) {
          triggers.push(args);
        },
      },
      holdLifecycle: {
        retireSatisfiedWait(event) {
          retired.push(event);
          return [];
        },
      },
      log,
    });

    await spec.run.execute(
      {
        task: {
          id: 'task-pr-1',
          kind: 'pr_tracking',
          title: 'PR #42',
          status: 'doing',
          threadId: 'thread-Q',
          ownerCatId: 'codex',
          userId: 'user1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subjectKey: 'pr:owner/repo#42',
          automationState: { intent: 'review' },
        },
        repoFullName: 'owner/repo',
        prNumber: 42,
      },
      'pr:owner/repo#42',
      {},
    );

    assert.deepEqual(retired, []);
    assert.deepEqual(triggers, []);
  });

  test('IssueCommentTaskSpec retires comment_posted holds after routing and persisting the pending wake', async () => {
    const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
    const retired = [];
    let routedWakePersisted = false;
    let wakeAccepted = false;

    const spec = createIssueCommentTaskSpec({
      taskStore: {},
      issueCommentRouter: {
        async route() {
          return {
            kind: 'notified',
            threadId: 'thread-Q',
            catId: 'codex',
            messageId: 'msg-issue-1',
            content: 'issue comment arrived',
          };
        },
      },
      fetchComments: async () => [],
      fetchIssueState: async () => 'open',
      holdLifecycle: {
        retireSatisfiedWait(event) {
          retired.push(event);
          return [];
        },
      },
      log,
    });

    await spec.run.execute(
      {
        task: {
          id: 'task-issue-1',
          kind: 'issue_tracking',
          title: 'Issue #42',
          status: 'doing',
          threadId: 'thread-Q',
          ownerCatId: 'codex',
          userId: 'user1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          subjectKey: 'issue:owner/repo#42',
        },
        repoFullName: 'owner/repo',
        issueNumber: 42,
        newComments: [{ id: 1002, author: 'maintainer', body: 'done', createdAt: new Date().toISOString() }],
        commitRoutedWake: async () => {
          routedWakePersisted = true;
        },
        commitWakeAccepted: async () => {
          wakeAccepted = true;
        },
      },
      'issue:owner/repo#42',
      {},
    );

    assert.equal(routedWakePersisted, true);
    assert.equal(wakeAccepted, false, 'a missing invoke trigger must not claim that the owner was woken');
    assert.deepEqual(retired, [
      {
        threadId: 'thread-Q',
        subjectKey: 'issue:owner/repo#42',
        expectedSignalKey: 'comment_posted',
        sourceKind: 'issue_comment',
        sourceMessageId: 'msg-issue-1',
      },
    ]);
  });
});
