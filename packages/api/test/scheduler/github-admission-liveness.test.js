import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createIssueCommentTaskSpec } from '../../dist/infrastructure/email/IssueCommentTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js';

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
