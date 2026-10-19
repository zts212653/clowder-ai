import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createIssueCommentTaskSpec } from '../../dist/infrastructure/email/IssueCommentTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';

for (const kind of ['pr_tracking', 'issue_tracking']) {
  test(`${kind}: a complete multi-request observation survives queue latency without replaying feedback`, async (t) => {
    // Preserve the real scheduler's 30s deadline calculation; compress only
    // object timers 100x. Metadata plus comment pages take 14s-equivalent:
    // each request fits its own budget, but the old 10s object cap never finishes.
    const timeout = AbortSignal.timeout;
    t.mock.method(AbortSignal, 'timeout', (ms) => timeout(Math.ceil(ms / 100)));
    const store = new TaskStore();
    const task = store.create({
      kind,
      threadId: 'owner-thread',
      subjectKey: `${kind === 'pr_tracking' ? 'pr' : 'issue'}:owner/repo#7`,
      title: 'tracked',
      ownerCatId: 'codex61-sol',
      why: 'collection progress regression',
      createdBy: 'codex61-sol',
      userId: 'u',
      automationState:
        kind === 'pr_tracking'
          ? { review: { lastInlineCommentCursor: 1, lastConversationCommentCursor: 1, lastDecisionCursor: 1 } }
          : { issue: { lastCommentCursor: 1, lastDeliveredCursor: 1, issueState: 'open' } },
    });
    if (kind === 'pr_tracking') {
      await store.patchAutomationState(task.id, {
        await: {
          v: 1,
          generation: 1,
          subjectRef: task.subjectKey,
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: {
            capturedAt: Date.now(),
            headSha: 'a'.repeat(40),
            review: { inlineCommentCursor: 1, conversationCommentCursor: 1, decisionCursor: 1 },
          },
          continuation: {
            when: [{ kind: 'pr_conversation_comment_added' }],
            // biome-ignore lint/suspicious/noThenProperty: frozen wait contract field.
            then: 'consume new feedback',
          },
          createdAt: Date.now(),
        },
      });
    }
    const delivered = [];
    const metadata = async (_repo, _number, signal) => {
      await delay(70, undefined, { signal });
      return { state: 'open', prState: 'open', headSha: 'a'.repeat(40) };
    };
    const opts = {
      taskStore: store,
      log: { info() {}, warn() {}, error() {} },
      fetchPrMetadata: metadata,
      fetchIssueMetadata: metadata,
      fetchComments: async (_repo, _number, cursor, signal) => {
        await delay(70, undefined, { signal });
        return (typeof cursor === 'number' ? cursor : cursor.conversation) >= 2
          ? []
          : [
              {
                id: 2,
                commentType: 'conversation',
                author: 'contributor',
                body: 'new feedback',
                createdAt: new Date().toISOString(),
              },
            ];
      },
      fetchReviews: async () => [],
      reviewFeedbackRouter: {
        route: async (signal) => {
          if (signal.newComments.length === 0) return { kind: 'skipped', reason: 'no new feedback' };
          delivered.push(signal.newComments[0].id);
          return {
            kind: 'notified',
            threadId: 'owner-thread',
            catId: 'codex61-sol',
            messageId: 'accepted',
            content: 'new feedback',
          };
        },
      },
      issueCommentRouter: {
        route: async (signal) => {
          if (signal.newComments.length === 0) return { kind: 'skipped', reason: 'no new feedback' };
          delivered.push(signal.newComments[0].id);
          return {
            kind: 'notified',
            threadId: 'owner-thread',
            catId: 'codex61-sol',
            messageId: 'accepted',
            content: 'new feedback',
          };
        },
      },
    };
    const spec = kind === 'pr_tracking' ? createReviewFeedbackTaskSpec(opts) : createIssueCommentTaskSpec(opts);
    const records = [];
    const run = () =>
      executeTaskPipeline({
        task: spec,
        ledger: { record: (row) => records.push(row) },
        logger: opts.log,
        running: new Map(),
        tickCounts: new Map(),
        lastRunAt: new Map(),
      });
    await run();
    assert.deepEqual(delivered, [2], 'the completed observation must reach routing');
    const state = store.get(task.id).automationState;
    assert.equal(
      kind === 'pr_tracking' ? state.review.lastConversationCommentCursor : state.issue.lastCommentCursor,
      2,
    );
    await run();
    assert.deepEqual(delivered, [2], 'the following poll must respect its committed cursor');
    assert.equal(
      records.some((row) => row.outcome === 'RUN_FAILED'),
      false,
    );
  });
}

for (const kind of ['pr_tracking', 'issue_tracking']) {
  test(`${kind}: cancellation reaches metadata, leaves cursors intact, and next poll starts after the slow object`, async () => {
    const store = new TaskStore();
    const tasks = [1, 2].map((number) =>
      store.create({
        kind,
        threadId: `thread-${number}`,
        subjectKey: `${kind === 'pr_tracking' ? 'pr' : 'issue'}:owner/repo#${number}`,
        title: 'tracked',
        ownerCatId: 'codex-astra',
        why: 'test',
        createdBy: 'codex-astra',
        userId: 'u',
        automationState:
          kind === 'pr_tracking'
            ? { review: { lastInlineCommentCursor: 1, lastConversationCommentCursor: 1, lastDecisionCursor: 1 } }
            : { issue: { lastCommentCursor: 1, lastDeliveredCursor: 1, issueState: 'open' } },
      }),
    );
    const before = tasks.map((task) => structuredClone(task.automationState));
    const controller = new AbortController();
    const lookedUp = [];
    let interrupt = true;
    const metadata = async (_repo, number, signal) => {
      lookedUp.push(number);
      assert(signal);
      if (interrupt) {
        interrupt = false;
        controller.abort(new Error('slow gate cancelled'));
        signal.throwIfAborted();
      }
      return { state: 'open', prState: 'open', headSha: 'a'.repeat(40) };
    };
    const opts = {
      taskStore: store,
      log: { info() {}, warn() {}, error() {} },
      fetchPrMetadata: metadata,
      fetchIssueMetadata: metadata,
      fetchIssueState: async () => 'open',
      fetchComments: async (_repo, _number, _cursor, signal) => {
        assert(signal);
        return [];
      },
      fetchReviews: async (_repo, _number, signal) => {
        assert(signal);
        return [];
      },
      reviewFeedbackRouter: { route: async () => ({ kind: 'skipped' }) },
      issueCommentRouter: { route: async () => ({ kind: 'skipped' }) },
    };
    const spec = kind === 'pr_tracking' ? createReviewFeedbackTaskSpec(opts) : createIssueCommentTaskSpec(opts);
    await assert.rejects(
      spec.admission.gate({
        taskId: spec.id,
        tickCount: 1,
        lastRunAt: null,
        signal: controller.signal,
        deadlineMs: Date.now() + 30_000,
      }),
      /slow gate cancelled/,
    );
    assert.deepEqual(
      tasks.map((task) => store.get(task.id)?.automationState),
      before,
    );
    await spec.admission.gate({
      taskId: spec.id,
      tickCount: 2,
      lastRunAt: null,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 30_000,
    });
    assert.deepEqual(lookedUp.slice(0, 2), [1, 2]);
  });
}
