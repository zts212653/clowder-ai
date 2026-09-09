import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createReviewFeedbackTaskSpec } = await import('../../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { classifyGitHubReviewLoopBrake } = await import('../../dist/domains/github-signals/github-wait-renderer.js');

async function createTracked(store) {
  return store.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: {
      review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20, lastDecisionCursor: 30 },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: 'aaa',
          review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30 },
        },
        continuation: {
          when: [{ kind: 'pr_review_decision_changed' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'continue',
        },
        autoRenew: true,
        createdAt: 100,
      },
    },
  });
}

function options(taskStore, router, overrides = {}) {
  return {
    taskStore,
    fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open' }),
    fetchComments: async () => [],
    fetchReviews: async () => [],
    reviewFeedbackRouter: router,
    log: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

describe('review scheduler F280 adapter', () => {
  test('routes before persisting the source cursor so a route failure remains retryable', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const controller = new AbortController();
    const events = [];
    const spec = createReviewFeedbackTaskSpec(
      options(taskStore, {
        route: async () => {
          events.push('routed');
          // An ordinary "did not match" skip DID evaluate the events; it is CAS exhaustion that
          // has not, and that is now the distinction the caller reads.
          return { kind: 'skipped', reason: 'test', observationEvaluated: true };
        },
      }),
    );

    await spec.run
      .execute(
        {
          repairedTask: task,
          repoFullName: 'owner/repo',
          prNumber: 7,
          newComments: [],
          newDecisions: [],
          headSha: 'aaa',
          inlineCommentCursor: 10,
          conversationCommentCursor: 20,
          decisionCursor: 31,
          commitCursor: async () => {
            events.push('cursor-persisted');
            controller.abort(new Error('scheduler timeout'));
          },
        },
        task.subjectKey,
        { assignedCatId: null, signal: controller.signal },
      )
      .catch(() => {});

    assert.deepEqual(events, ['routed', 'cursor-persisted']);
  });

  /*
   * sol R30, at the layer where the loss actually happens.
   *
   * When outcome N is still undelivered, the wait re-publishes it and never reads the items in
   * THIS signal. `kind === 'notified'` therefore said "delivered" while nothing had been
   * evaluated, and the cursor moved past feedback no one looked at — permanently. Leaving the
   * cursor put costs one poll cycle; advancing it costs the comment.
   */
  test('a re-published pending outcome wakes its owner without advancing the source cursor', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const events = [];
    const policies = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async () => {
            events.push('routed');
            return {
              kind: 'notified',
              threadId: 't1',
              catId: 'opus',
              messageId: 'm1',
              content: 'generation N, re-delivered',
              observationEvaluated: false,
              // What generation N itself terminated on — the signal in hand describes N+1.
              terminalSubjectState: 'merged',
            };
          },
        },
        {
          invokeTrigger: {
            trigger: async (_thread, _cat, _user, _content, _msg, _extra, policy) => {
              events.push('triggered');
              policies.push(policy);
            },
          },
        },
      ),
    );

    await spec.run.execute(
      {
        repairedTask: task,
        repoFullName: 'owner/repo',
        prNumber: 7,
        newComments: [],
        newDecisions: [],
        headSha: 'aaa',
        inlineCommentCursor: 10,
        conversationCommentCursor: 20,
        decisionCursor: 31,
        commitCursor: async () => {
          events.push('cursor-persisted');
        },
      },
      task.subjectKey,
      { assignedCatId: null },
    );

    // sol R31: BOTH halves. Skipping the cursor was right; skipping the wake with it swapped one
    // silent loss for another — the re-published outcome reached the connector while its owner
    // was never Queue-admitted, and the next round folded it into the renewed baseline where it
    // could never match again.
    assert.deepEqual(
      events,
      ['routed', 'triggered'],
      'an unevaluated observation earns no cursor advance, but a delivered outcome still wakes its owner',
    );
    assert.equal(policies.length, 1);
    assert.equal(policies[0].priority, 'normal', 'urgency may not be inferred from the unevaluated signal');
    assert.equal(policies[0].reason, 'github_pr_merged', "the re-published outcome's OWN terminal state shapes it");
  });

  test('an evaluated observation still advances the source cursor', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const events = [];
    const spec = createReviewFeedbackTaskSpec(
      options(taskStore, {
        route: async () => {
          events.push('routed');
          return {
            kind: 'notified',
            threadId: 't1',
            catId: 'opus',
            messageId: 'm1',
            content: 'evaluated',
            observationEvaluated: true,
          };
        },
      }),
    );

    await spec.run.execute(
      {
        repairedTask: task,
        repoFullName: 'owner/repo',
        prNumber: 7,
        newComments: [],
        newDecisions: [],
        headSha: 'aaa',
        inlineCommentCursor: 10,
        conversationCommentCursor: 20,
        decisionCursor: 31,
        commitCursor: async () => {
          events.push('cursor-persisted');
        },
      },
      task.subjectKey,
      { assignedCatId: null },
    );

    assert.deepEqual(events, ['routed', 'cursor-persisted']);
  });

  test('current facts are evaluated even when no raw source body is deliverable', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const spec = createReviewFeedbackTaskSpec(
      options(taskStore, {
        route: async () => ({ kind: 'skipped', reason: 'not matched', observationEvaluated: true }),
      }),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
  });

  test('only router-confirmed typed outcome invokes with the unified reason', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async () => ({
            kind: 'notified',
            // This case is about a real evaluated observation; say so rather than inherit a default.
            observationEvaluated: true,
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            content: 'compact wait',
          }),
        },
        {
          fetchReviews: async () => [
            {
              id: 31,
              author: 'reviewer',
              state: 'APPROVED',
              body: 'SOURCE',
              submittedAt: '2026-07-30T00:00:00Z',
              commitId: 'aaa',
            },
          ],
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][6].reason, 'github_wait_satisfied');
    assert.equal(calls[0][6].suggestedSkill, undefined);
  });

  test('a known formal review dismissal is routed once even though its review id does not change', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    await taskStore.patchAutomationState(task.id, {
      review: { activeDecisionStatesByReviewId: { 30: 'APPROVED' } },
    });
    const routed = [];
    const fetchArgs = [];
    const dismissed = {
      id: 30,
      author: 'maintainer',
      state: 'DISMISSED',
      body: 'The approval no longer applies.',
      submittedAt: '2026-09-08T00:00:00Z',
      commitId: 'aaa',
    };
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => {
            routed.push(signal.newDecisions);
            return { kind: 'skipped', reason: 'test', observationEvaluated: true };
          },
        },
        {
          fetchReviews: async (...args) => {
            fetchArgs.push(args);
            return [dismissed];
          },
        },
      ),
    );

    const first = await spec.admission.gate();
    assert.equal(
      fetchArgs[0][2],
      undefined,
      'review collection must fetch current states, not only ids above the cursor',
    );
    assert.equal(first.workItems[0].signal.newDecisions.length, 1);
    assert.deepEqual(first.workItems[0].signal.newDecisions[0], {
      ...dismissed,
      previousState: 'APPROVED',
    });
    await spec.run.execute(first.workItems[0].signal, first.workItems[0].subjectKey, {});
    assert.deepEqual((await taskStore.get(task.id)).automationState.review.activeDecisionStatesByReviewId, {});

    const second = await spec.admission.gate();
    assert.deepEqual(second.workItems[0].signal.newDecisions, [], 'the persisted dismissal receipt prevents replay');
  });

  test('an upgraded task seeds old review states without replaying a historical dismissal', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const routed = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => {
            routed.push(signal.newDecisions);
            return { kind: 'skipped', reason: 'test', observationEvaluated: true };
          },
        },
        {
          fetchReviews: async () => [
            {
              id: 29,
              author: 'maintainer',
              state: 'DISMISSED',
              body: 'Historical dismissal',
              submittedAt: '2026-09-01T00:00:00Z',
              commitId: 'aaa',
            },
            {
              id: 30,
              author: 'maintainer',
              state: 'APPROVED',
              body: 'Still active',
              submittedAt: '2026-09-02T00:00:00Z',
              commitId: 'aaa',
            },
          ],
        },
      ),
    );

    const gate = await spec.admission.gate();
    assert.deepEqual(gate.workItems[0].signal.newDecisions, []);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.deepEqual(routed, [[]]);
    assert.deepEqual((await taskStore.get(task.id)).automationState.review.activeDecisionStatesByReviewId, {
      30: 'APPROVED',
    });
  });

  test('plain @codex review advances the source frontier without forcing invocation', async () => {
    const taskStore = new TaskStore();
    const task = await createTracked(taskStore);
    const calls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          // `predicates_not_matched` is precisely the shape that DID evaluate: the lifecycle
          // installs the advanced baseline built from these events before returning it.
          route: async () => ({ kind: 'skipped', reason: 'predicates_not_matched', observationEvaluated: true }),
        },
        {
          fetchComments: async () => [
            {
              id: 21,
              author: 'human',
              body: '@codex review',
              createdAt: '2026-07-30T00:00:00Z',
              commentType: 'conversation',
            },
          ],
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.review.lastConversationCommentCursor, 21);
  });

  test('PR terminal truth is routed through the wait lifecycle even when CI collection is unavailable', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const routerCalls = [];
    const triggerCalls = [];
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => {
            routerCalls.push(signal);
            return {
              kind: 'notified',
              // This case is about a real evaluated observation; say so rather than inherit a default.
              observationEvaluated: true,
              threadId: 'thread_1',
              catId: 'codex-sol',
              messageId: 'terminal_msg',
              content: 'compact terminal wait',
            };
          },
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'merged' }),
          invokeTrigger: { trigger: async (...args) => triggerCalls.push(args) },
        },
      ),
    );

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
    assert.equal(gate.workItems[0].signal.subjectState, 'merged');
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(routerCalls.length, 1);
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0][6].reason, 'github_pr_merged');
  });

  test('the fourth formal changes-requested review pauses one automatic owner wake, while the fifth continues', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    const history = [1, 2, 3, 4].map((id) => ({
      id: 27 + id,
      author: `reviewer-${id}`,
      state: 'CHANGES_REQUESTED',
      body: '',
      submittedAt: `2026-09-0${id}T00:00:00Z`,
      commitId: 'aaa',
    }));
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async (signal) => ({
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            content: signal.reviewLoopBrake?.kind ?? 'none',
            observationEvaluated: true,
            // Production stamps the pause onto the OUTCOME; this stub mirrors that rather than
            // letting the caller read it back off the signal. The end-to-end proof that the
            // lifecycle really stamps it lives in the wait-lifecycle suite.
            ...(signal.reviewLoopBrake?.kind === 'pause_once' ? { autoWakeSuppressed: true } : {}),
          }),
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open', authorLogin: 'pr-author' }),
          fetchReviews: async (_repo, _pr, sinceId) =>
            sinceId === undefined ? history : history.filter((r) => r.id > sinceId),
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.workItems[0].signal.reviewLoopBrake.kind, 'pause_once');
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 0);

    const fifth = { ...history.at(-1), id: 32, author: 'reviewer-5' };
    const continued = classifyGitHubReviewLoopBrake([...history, fifth], [fifth.id], 'pr-author');
    assert.equal(continued.kind, 'continue');
  });

  test('the full review observation is reused as brake history without a second fetch', async () => {
    const taskStore = new TaskStore();
    await createTracked(taskStore);
    const calls = [];
    let fetchCalls = 0;
    const fresh = {
      id: 31,
      author: 'reviewer-4',
      state: 'CHANGES_REQUESTED',
      body: '',
      submittedAt: '2026-09-04T00:00:00Z',
      commitId: 'aaa',
    };
    const spec = createReviewFeedbackTaskSpec(
      options(
        taskStore,
        {
          route: async () => ({
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            content: 'warn-open',
            // A real evaluated observation; the warn-open path is about review history, not about
            // a re-published pending outcome.
            observationEvaluated: true,
          }),
        },
        {
          fetchPrMetadata: async () => ({ headSha: 'aaa', prState: 'open', authorLogin: 'pr-author' }),
          fetchReviews: async () => {
            fetchCalls++;
            return [fresh];
          },
          invokeTrigger: { trigger: async (...args) => calls.push(args) },
        },
      ),
    );
    const gate = await spec.admission.gate();
    assert.equal(gate.workItems[0].signal.reviewLoopBrake.kind, 'continue');
    assert.equal(fetchCalls, 1);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(calls.length, 1);
  });
});
