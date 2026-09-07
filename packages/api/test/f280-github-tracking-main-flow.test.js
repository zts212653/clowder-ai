import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { normalizeIssueComments, normalizePrFeedbackComments, normalizePrReviewDecisions } = await import(
  '../dist/infrastructure/github/github-feedback-payload.js'
);
const { ReviewFeedbackRouter } = await import('../dist/infrastructure/email/ReviewFeedbackRouter.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { IssueCommentRouter } = await import('../dist/infrastructure/email/IssueCommentRouter.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');
const { createConflictCheckTaskSpec } = await import('../dist/infrastructure/email/ConflictCheckTaskSpec.js');

const logger = { info() {}, warn() {}, error() {} };

const upstreamConversationComment = Object.freeze({
  id: 21,
  body: 'The retry still loses this notification after the new push.',
  created_at: '2026-09-02T09:30:00Z',
  user: { login: 'ExternalMaintainer', type: 'User' },
  author_association: 'MEMBER',
});

async function createTrackingTask(
  taskStore,
  when = [
    { kind: 'pr_review_decision_changed' },
    { kind: 'pr_conversation_comment_added' },
    { kind: 'pr_inline_comment_added' },
  ],
) {
  return taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#1394',
    threadId: 'thread-registration',
    title: 'Track PR #1394',
    ownerCatId: 'cat-self',
    why: 'Notify the registration thread about external GitHub responses.',
    createdBy: 'cat-self',
    userId: 'user-1',
    automationState: {
      review: { lastInlineCommentCursor: 10, lastConversationCommentCursor: 20, lastDecisionCursor: 30 },
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#1394',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: {
          capturedAt: 100,
          headSha: 'old-head',
          review: { inlineCommentCursor: 10, conversationCommentCursor: 20, decisionCursor: 30 },
        },
        continuation: {
          when,
          // biome-ignore lint/suspicious/noThenProperty: frozen internal continuation field.
          then: 'Handle the external response.',
        },
        autoRenew: true,
        createdAt: 100,
      },
    },
  });
}

async function createReviewHarness({ inline = [], conversation = [], reviews = [], eventLog } = {}) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const task = await createTrackingTask(taskStore);
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    now: () => 1_000,
    log: logger,
  });
  const router = new ReviewFeedbackRouter({
    deliveryDeps: { messageStore },
    waitLifecycle: lifecycle,
    log: logger,
  });
  const spec = createReviewFeedbackTaskSpec({
    id: 'github-review-feedback-main-flow',
    taskStore,
    reviewFeedbackRouter: router,
    fetchPrMetadata: async () => ({ headSha: 'new-head', prState: 'open' }),
    fetchComments: async () => normalizePrFeedbackComments(inline, conversation),
    fetchReviews: async () => normalizePrReviewDecisions(reviews),
    isEchoComment: (comment) => comment.author.toLowerCase() === 'cat-self',
    isEchoReview: (review) => review.author.toLowerCase() === 'cat-self',
    eventLog,
    log: logger,
  });
  return { taskStore, messageStore, task, spec };
}

async function runOnePoll(spec) {
  const gate = await spec.admission.gate();
  assert.equal(gate.run, true);
  for (const item of gate.workItems) {
    await spec.run.execute(item.signal, item.subjectKey, {
      assignedCatId: null,
      signal: new AbortController().signal,
    });
  }
}

describe('#1394 GitHub tracking main flow', () => {
  test('the production payload adapter preserves the upstream comment contract', () => {
    const [comment] = normalizePrFeedbackComments([], [upstreamConversationComment]);
    assert.deepEqual(comment, {
      id: 21,
      author: 'ExternalMaintainer',
      actorType: 'User',
      body: upstreamConversationComment.body,
      createdAt: upstreamConversationComment.created_at,
      commentType: 'conversation',
      authorAssociation: 'MEMBER',
    });
  });

  test('a response after a HEAD push travels from the real poller through the lifecycle into MessageStore', async () => {
    const { messageStore, spec } = await createReviewHarness({ conversation: [upstreamConversationComment] });
    await runOnePoll(spec);

    const delivered = messageStore.getByThread('thread-registration');
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content, /ExternalMaintainer/);
    assert.match(delivered[0].content, /retry still loses this notification/);
  });

  test('conversation, inline, and formal-review payloads share one delivery path without loss', async () => {
    const inline = {
      id: 11,
      body: 'Please keep the cursor per source.',
      created_at: '2026-09-02T09:31:00Z',
      user: { login: 'InlineReviewer', type: 'User' },
      pull_request_review_id: 900,
      commit_id: 'old-head',
      path: 'src/wait.ts',
      line: 42,
    };
    const review = {
      id: 31,
      body: 'One more thing before approval.',
      submitted_at: '2026-09-02T09:32:00Z',
      user: { login: 'FormalReviewer', type: 'User' },
      state: 'COMMENTED',
      commit_id: 'old-head',
    };
    const { messageStore, spec } = await createReviewHarness({
      inline: [inline],
      conversation: [upstreamConversationComment],
      reviews: [review],
    });

    await runOnePoll(spec);

    const [message] = messageStore.getByThread('thread-registration');
    assert.match(message.content, /ExternalMaintainer/);
    assert.match(message.content, /InlineReviewer/);
    assert.match(message.content, /FormalReviewer/);
    assert.match(message.content, /One more thing before approval/);
  });

  test('all three self-authored surfaces are consumed without notifying, case-insensitively', async () => {
    const { messageStore, taskStore, task, spec } = await createReviewHarness({
      inline: [
        {
          id: 11,
          body: 'self inline',
          created_at: '2026-09-02T09:31:00Z',
          user: { login: 'CAT-SELF', type: 'User' },
          pull_request_review_id: 901,
        },
      ],
      conversation: [
        {
          ...upstreamConversationComment,
          body: 'self conversation',
          user: { login: 'Cat-Self', type: 'User' },
        },
      ],
      reviews: [
        {
          id: 31,
          body: 'self formal review',
          submitted_at: '2026-09-02T09:32:00Z',
          user: { login: 'cat-self', type: 'User' },
          state: 'COMMENTED',
        },
      ],
    });

    await runOnePoll(spec);

    assert.equal(messageStore.getByThread('thread-registration').length, 0);
    const stored = await taskStore.get(task.id);
    assert.equal(stored.automationState.review.lastInlineCommentCursor, 11);
    assert.equal(stored.automationState.review.lastConversationCommentCursor, 21);
    assert.equal(stored.automationState.review.lastDecisionCursor, 31);
  });

  // F280 section 2.4: a bot that is not one of OUR known bots is just an external responder.
  // It is not a bot turn (nobody summoned it) and it is not noise — dropping it is how the
  // most valuable signal on a PR goes missing.
  test('an unknown bot response is delivered with its body, not classified away', async () => {
    const botComment = {
      ...upstreamConversationComment,
      body: 'Automated dependency update is ready.',
      user: { login: 'dependabot[bot]', type: 'Bot' },
    };
    const { messageStore, spec } = await createReviewHarness({
      conversation: [botComment],
    });

    await runOnePoll(spec);

    const [message] = messageStore.getByThread('thread-registration');
    assert.match(message.content, /dependabot\[bot\]/);
    assert.match(message.content, /dependency update is ready/);
  });

  test('two formal COMMENTED reviews with unchanged decision text notify twice across renewal', async () => {
    const reviews = [
      {
        id: 31,
        body: 'First requested adjustment.',
        submitted_at: '2026-09-02T09:32:00Z',
        user: { login: 'Reviewer', type: 'User' },
        state: 'COMMENTED',
      },
    ];
    const { messageStore, taskStore, task, spec } = await createReviewHarness({ reviews });
    await runOnePoll(spec);
    reviews.push({
      id: 32,
      body: 'Second requested adjustment.',
      submitted_at: '2026-09-02T09:33:00Z',
      user: { login: 'Reviewer', type: 'User' },
      state: 'COMMENTED',
    });
    await runOnePoll(spec);

    const messages = messageStore.getByThread('thread-registration');
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /First requested adjustment/);
    assert.match(messages[1].content, /Second requested adjustment/);
    const stored = await taskStore.get(task.id);
    assert.equal(stored.automationState.await.generation, 3);
    assert.equal(Object.hasOwn(stored.automationState.await, 'expiresAt'), false);
  });

  test('an inline comment fires once, then the next inline comment fires after renewal', async () => {
    const inline = [
      {
        id: 11,
        body: 'First inline response.',
        created_at: '2026-09-02T09:31:00Z',
        user: { login: 'InlineReviewer', type: 'User' },
        pull_request_review_id: 901,
      },
    ];
    const { messageStore, spec } = await createReviewHarness({ inline });

    await runOnePoll(spec);
    await runOnePoll(spec);
    inline.push({
      id: 12,
      body: 'Second inline response.',
      created_at: '2026-09-02T09:32:00Z',
      user: { login: 'InlineReviewer', type: 'User' },
      pull_request_review_id: 901,
    });
    await runOnePoll(spec);

    const messages = messageStore.getByThread('thread-registration');
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /First inline response/);
    assert.match(messages[1].content, /Second inline response/);
  });

  test('a community projection failure neither hides nor repeats an external review', async () => {
    const reviews = [
      {
        id: 31,
        body: 'First review in the batch.',
        submitted_at: '2026-09-02T09:32:00Z',
        user: { login: 'ReviewerOne', type: 'User' },
        state: 'COMMENTED',
      },
      {
        id: 32,
        body: 'Second review in the batch.',
        submitted_at: '2026-09-02T09:33:00Z',
        user: { login: 'ReviewerTwo', type: 'User' },
        state: 'COMMENTED',
      },
    ];
    let failSecondOnce = true;
    const eventLog = {
      async append(event) {
        if (event.sourceEventId.endsWith(':32') && failSecondOnce) {
          failSecondOnce = false;
          throw new Error('community projection unavailable');
        }
        return { appended: true };
      },
      async read() {
        return [];
      },
    };
    const { messageStore, taskStore, task, spec } = await createReviewHarness({ reviews, eventLog });

    await runOnePoll(spec);
    await runOnePoll(spec);

    const messages = messageStore.getByThread('thread-registration');
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /First review in the batch/);
    assert.match(messages[0].content, /Second review in the batch/);
    assert.equal((await taskStore.get(task.id)).automationState.review.lastDecisionCursor, 32);
  });

  test('a base-behind state reaches MessageStore even while mergeability is still UNKNOWN', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#1394',
      threadId: 'thread-registration',
      title: 'Track PR #1394',
      ownerCatId: 'cat-self',
      why: 'Notify the registration thread about external GitHub state changes.',
      createdBy: 'cat-self',
      userId: 'user-1',
      automationState: {
        conflict: { mergeState: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'pr:owner/repo#1394',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: {
            capturedAt: 100,
            headSha: 'same-head',
            conflict: { mergeState: 'MERGEABLE' },
            base: { isBehind: false },
          },
          continuation: {
            when: [{ kind: 'pr_base_behind' }],
            // biome-ignore lint/suspicious/noThenProperty: frozen internal continuation field.
            then: 'Rebase onto the current base branch.',
          },
          autoRenew: true,
          createdAt: 100,
        },
      },
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 1_000,
      log: logger,
    });
    const router = new ConflictRouter({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle: lifecycle,
      log: logger,
    });
    const spec = createConflictCheckTaskSpec({
      id: 'github-conflict-main-flow',
      taskStore,
      conflictRouter: router,
      checkMergeable: async () => ({
        headSha: 'same-head',
        mergeState: 'UNKNOWN',
        mergeStateStatus: 'BEHIND',
      }),
      log: logger,
    });

    await runOnePoll(spec);

    const [message] = messageStore.getByThread('thread-registration');
    assert.match(message.content, /base branch advanced/);
    assert.match(message.content, /Rebase onto the current base branch/);
  });
});

describe('#1394 issue tracking main flow', () => {
  async function createIssueHarness(rawComments, eventLog) {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#1392',
      threadId: 'thread-issue-registration',
      title: 'Track issue #1392',
      ownerCatId: 'cat-self',
      why: 'Notify this thread about external issue comments.',
      createdBy: 'cat-self',
      userId: 'user-1',
      automationState: {
        issue: { lastCommentCursor: 100, lastDeliveredCursor: 100, issueState: 'open' },
        await: {
          v: 1,
          generation: 1,
          subjectRef: 'issue:owner/repo#1392',
          ownerFence: { kind: 'containing_task', generation: 1 },
          baseline: { capturedAt: 100, issue: { lastCommentCursor: 100, state: 'open' } },
          continuation: {
            when: [{ kind: 'issue_comment_added' }],
            // biome-ignore lint/suspicious/noThenProperty: frozen internal continuation field.
            then: 'Handle the external issue response.',
          },
          autoRenew: true,
          createdAt: 100,
        },
      },
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 1_000,
      log: logger,
    });
    const issueRouter = new IssueCommentRouter({ deliveryDeps: { messageStore }, log: logger });
    const spec = createIssueCommentTaskSpec({
      id: 'github-issue-comment-main-flow',
      taskStore,
      issueCommentRouter: issueRouter,
      waitLifecycle: lifecycle,
      fetchComments: async () => normalizeIssueComments(rawComments),
      fetchIssueState: async () => 'open',
      isEchoComment: (comment) => comment.author.toLowerCase() === 'cat-self',
      isNoiseComment: () => true,
      eventLog,
      log: logger,
    });
    return { task, taskStore, messageStore, spec };
  }

  test('a bot comment is delivered with content while a critical-looking self comment is only consumed', async () => {
    const rawComments = [
      {
        id: 101,
        body: 'critical: deploy is broken',
        created_at: '2026-09-02T09:30:00Z',
        user: { login: 'CAT-SELF', type: 'User' },
      },
      {
        id: 102,
        body: 'Automated scan found a concrete regression.',
        created_at: '2026-09-02T09:31:00Z',
        user: { login: 'quality-bot[bot]', type: 'Bot' },
      },
    ];
    const { task, taskStore, messageStore, spec } = await createIssueHarness(rawComments);

    await runOnePoll(spec);

    const [message] = messageStore.getByThread('thread-issue-registration');
    assert.match(message.content, /quality-bot\[bot\]/);
    assert.match(message.content, /concrete regression/);
    assert.doesNotMatch(message.content, /deploy is broken/);
    const stored = await taskStore.get(task.id);
    assert.equal(stored.automationState.issue.lastCommentCursor, 102);
    assert.equal(stored.automationState.await.generation, 2);
  });

  test('an issue response is neither hidden nor repeated by a community-log failure', async () => {
    const rawComments = [
      {
        id: 101,
        body: 'First issue response.',
        created_at: '2026-09-02T09:30:00Z',
        user: { login: 'MaintainerOne', type: 'User' },
      },
      {
        id: 102,
        body: 'Second issue response.',
        created_at: '2026-09-02T09:31:00Z',
        user: { login: 'MaintainerTwo', type: 'User' },
      },
    ];
    let failSecondOnce = true;
    const eventLog = {
      async append(event) {
        if (event.sourceEventId.endsWith(':102') && failSecondOnce) {
          failSecondOnce = false;
          throw new Error('community log unavailable');
        }
        return { appended: true };
      },
    };
    const { task, taskStore, messageStore, spec } = await createIssueHarness(rawComments, eventLog);

    await runOnePoll(spec);
    await runOnePoll(spec);

    const messages = messageStore.getByThread('thread-issue-registration');
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /First issue response/);
    assert.match(messages[0].content, /Second issue response/);
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastCommentCursor, 102);
  });
});
