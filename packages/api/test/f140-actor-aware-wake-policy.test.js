import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const deliveryPolicy = await import('../dist/domains/community/community-delivery-policy.js');
const { createReviewFeedbackTaskSpec } = await import('../dist/infrastructure/email/ReviewFeedbackTaskSpec.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');

function mergeAutomationState(current = {}, patch = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      value && typeof value === 'object' && !Array.isArray(value) ? { ...(merged[key] ?? {}), ...value } : value;
  }
  return merged;
}

function makeTaskStore(task) {
  const tasks = new Map([[task.id, structuredClone(task)]]);
  const patches = [];
  return {
    tasks,
    patches,
    async listByKind(kind) {
      return [...tasks.values()].filter((candidate) => candidate.kind === kind && candidate.status !== 'done');
    },
    async get(id) {
      return tasks.get(id) ?? null;
    },
    async update(id, patch) {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, ...patch });
    },
    async updateIfThreadId(id, expectedThreadId, patch) {
      const current = tasks.get(id);
      if (!current || current.threadId !== expectedThreadId) return null;
      const next = { ...current, ...patch };
      tasks.set(id, next);
      return next;
    },
    async patchAutomationState(id, patch) {
      patches.push(structuredClone(patch));
      const current = tasks.get(id);
      if (!current) return null;
      const next = { ...current, automationState: mergeAutomationState(current.automationState, patch) };
      tasks.set(id, next);
      return next;
    },
  };
}

function makeEventLog() {
  const events = [];
  return {
    events,
    async append(event) {
      if (events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
        return { appended: false, sequence: -1 };
      }
      events.push(structuredClone(event));
      return { appended: true, sequence: events.length - 1 };
    },
    async read(subjectKey) {
      return events.filter((event) => event.subjectKey === subjectKey);
    },
    async listSubjects() {
      return [...new Set(events.map((event) => event.subjectKey))];
    },
  };
}

function makeRouter() {
  const calls = [];
  return {
    calls,
    async route(signal, tracking) {
      calls.push({ signal: structuredClone(signal), tracking: structuredClone(tracking) });
      return {
        kind: 'notified',
        threadId: tracking.threadId,
        catId: tracking.catId,
        messageId: `message-${calls.length}`,
        content: 'fixture notification',
      };
    },
  };
}

function makeInvokeTrigger() {
  const calls = [];
  return {
    calls,
    async trigger(...args) {
      calls.push(args);
      return { invoked: true };
    },
  };
}

function makePrTask(wakePolicy = 'human_participant_activity') {
  return {
    id: 'pr-task',
    kind: 'pr_tracking',
    status: 'doing',
    subjectKey: 'pr:owner/repo#1185',
    threadId: 'thread-pr',
    ownerCatId: 'codex-sol',
    userId: 'user-1',
    createdAt: 1,
    automationState: {
      wakePolicy,
      review: {
        lastCommentCursor: 0,
        lastInlineCommentCursor: 0,
        lastConversationCommentCursor: 0,
        lastDecisionCursor: 0,
      },
    },
  };
}

function makeIssueTask(wakePolicy = 'human_participant_activity') {
  return {
    id: 'issue-task',
    kind: 'issue_tracking',
    status: 'doing',
    subjectKey: 'issue:owner/repo#42',
    threadId: 'thread-issue',
    ownerCatId: 'codex-sol',
    userId: 'user-1',
    createdAt: 1,
    automationState: {
      wakePolicy,
      issue: { lastCommentCursor: 0, lastDeliveredCursor: 0 },
    },
  };
}

const log = { info() {}, warn() {}, error() {} };

async function executeGate(spec, gate) {
  if (!gate.run) return;
  for (const item of gate.workItems) {
    await spec.run.execute(item.signal, item.subjectKey, {});
  }
}

describe('F140 actor-aware tracking wake decision', () => {
  const cases = [
    {
      name: 'subject author is identified by login and User actor type',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'pr-author',
        actorType: 'User',
        subjectAuthorLogin: 'PR-AUTHOR',
      },
      expected: { decision: 'deliver', reason: 'subject_author' },
    },
    {
      name: 'third-party human participant delivers regardless of repository association',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'reviewer',
        actorType: 'User',
        subjectAuthorLogin: 'pr-author',
        authorAssociation: 'OWNER',
      },
      expected: { decision: 'deliver', reason: 'human_participant' },
    },
    {
      name: 'Bot is state-only even when authorAssociation says OWNER',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'automation',
        actorType: 'Bot',
        subjectAuthorLogin: 'pr-author',
        authorAssociation: 'OWNER',
      },
      expected: { decision: 'state_only', reason: 'automation_actor' },
    },
    {
      name: 'missing actor type fails safe to delivery',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'mystery',
        subjectAuthorLogin: 'pr-author',
      },
      expected: { decision: 'deliver', reason: 'unknown_actor' },
    },
    {
      name: 'unrecognized actor type fails safe to delivery',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'org-actor',
        actorType: 'Organization',
        subjectAuthorLogin: 'pr-author',
      },
      expected: { decision: 'deliver', reason: 'unknown_actor' },
    },
    {
      name: 'all_feedback keeps Bot delivery for backward compatibility',
      input: {
        wakePolicy: 'all_feedback',
        actorLogin: 'automation',
        actorType: 'Bot',
        subjectAuthorLogin: 'pr-author',
      },
      expected: { decision: 'deliver', reason: 'all_feedback' },
    },
    {
      name: 'absent policy resolves to all_feedback',
      input: {
        actorLogin: 'automation',
        actorType: 'Bot',
        subjectAuthorLogin: 'pr-author',
      },
      expected: { decision: 'deliver', reason: 'all_feedback' },
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      assert.equal(typeof deliveryPolicy.decideTrackingWake, 'function');
      assert.deepEqual(deliveryPolicy.decideTrackingWake(fixture.input), fixture.expected);
    });
  }
});

describe('ReviewFeedbackTaskSpec actor-aware delivery', () => {
  it('keeps legacy split-cursor history durable and state-only during migration', async () => {
    const task = makePrTask();
    task.automationState.review = {
      lastCommentCursor: 5_022_122_831,
      lastDecisionCursor: 4_736_778_825,
    };
    const taskStore = makeTaskStore(task);
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const seenCursors = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      reviewFeedbackRouter: router,
      invokeTrigger,
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async (_repo, _pr, cursors) => {
        seenCursors.push(cursors);
        return [
          {
            id: 3_612_718_590,
            author: 'human-reviewer',
            actorType: 'User',
            body: 'historical inline feedback',
            createdAt: '2026-07-18T00:00:01Z',
            commitId: 'old-head-before-migration',
            commentType: 'inline',
          },
          {
            id: 5_022_122_831,
            author: 'pr-author',
            actorType: 'User',
            body: 'historical owner reply',
            createdAt: '2026-07-18T00:00:02Z',
            commentType: 'conversation',
          },
        ];
      },
      fetchReviews: async () => [],
      log,
    });

    const gate = await spec.admission.gate();

    assert.equal(gate.run, false, 'schema migration history must not become fresh human activity');
    assert.deepEqual(seenCursors, [{ inline: 0, conversation: 0 }]);
    assert.deepEqual(
      eventLog.events.map((event) => ({
        id: event.payload.commentId,
        type: event.payload.commentType,
        actorType: event.payload.actorType,
      })),
      [
        { id: 3_612_718_590, type: 'inline', actorType: 'User' },
        { id: 5_022_122_831, type: 'conversation', actorType: 'User' },
      ],
    );
    assert.equal(router.calls.length, 0);
    assert.equal(invokeTrigger.calls.length, 0);
    const state = taskStore.tasks.get('pr-task').automationState.review;
    assert.equal(state.lastInlineCommentCursor, 3_612_718_590);
    assert.equal(state.lastConversationCommentCursor, 5_022_122_831);
    assert.deepEqual(state.commentCursorMigrationTargets, {
      inline: 3_612_718_590,
      conversation: 5_022_122_831,
    });
    assert.equal(state.commentCursorMigrationPending, false);
  });

  it('keeps the frozen partial backfill state-only while later source feedback stays live', async () => {
    const task = makePrTask();
    task.automationState.review = { lastCommentCursor: 100, lastDecisionCursor: 0 };
    const taskStore = makeTaskStore(task);
    const eventLog = makeEventLog();
    const append = eventLog.append.bind(eventLog);
    let inlineFailuresRemaining = 2;
    eventLog.append = async (event) => {
      if (inlineFailuresRemaining > 0 && event.sourceEventId.endsWith(':inline:11')) {
        inlineFailuresRemaining -= 1;
        throw new Error('fixture append failure');
      }
      return append(event);
    };
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const liveComments = [];
    const comments = [
      {
        id: 10,
        author: 'reviewer-a',
        actorType: 'User',
        body: 'historical inline one',
        createdAt: '2026-07-18T00:00:01Z',
        commitId: 'old-head-before-migration',
        commentType: 'inline',
      },
      {
        id: 11,
        author: 'reviewer-b',
        actorType: 'User',
        body: 'historical inline two',
        createdAt: '2026-07-18T00:00:02Z',
        commitId: 'old-head-before-migration',
        commentType: 'inline',
      },
      {
        id: 100,
        author: 'pr-author',
        actorType: 'User',
        body: 'historical conversation',
        createdAt: '2026-07-18T00:00:03Z',
        commentType: 'conversation',
      },
    ];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      eventLog,
      reviewFeedbackRouter: router,
      invokeTrigger,
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async () => [...comments, ...liveComments],
      fetchReviews: async () => [],
      log,
    });

    const first = await spec.admission.gate();
    assert.equal(first.run, false);
    let state = taskStore.tasks.get('pr-task').automationState.review;
    assert.equal(state.lastInlineCommentCursor, 10);
    assert.equal(state.lastConversationCommentCursor, 100);
    assert.deepEqual(state.commentCursorMigrationTargets, { inline: 11, conversation: 100 });
    assert.equal(state.commentCursorMigrationPending, true);

    liveComments.push({
      id: 101,
      author: 'community-human',
      actorType: 'User',
      body: 'genuinely new feedback while inline migration is still retrying',
      createdAt: '2026-07-20T00:00:01Z',
      commentType: 'conversation',
    });
    const second = await spec.admission.gate();
    assert.equal(second.run, true, 'activity beyond a completed source snapshot remains live');
    assert.deepEqual(
      second.workItems[0].signal.newComments.map((comment) => comment.id),
      [101],
    );
    await executeGate(spec, second);
    state = taskStore.tasks.get('pr-task').automationState.review;
    assert.equal(state.lastInlineCommentCursor, 10);
    assert.equal(state.lastConversationCommentCursor, 101);
    assert.equal(state.commentCursorMigrationPending, true);
    assert.equal(router.calls.length, 1);
    assert.equal(invokeTrigger.calls.length, 1);

    const third = await spec.admission.gate();
    assert.equal(third.run, false, 'retried historical tail remains state-only');
    state = taskStore.tasks.get('pr-task').automationState.review;
    assert.equal(state.lastInlineCommentCursor, 11);
    assert.equal(state.lastConversationCommentCursor, 101);
    assert.equal(state.commentCursorMigrationPending, false);
    assert.equal(router.calls.length, 1);
    assert.equal(invokeTrigger.calls.length, 1);

    liveComments.push({
      id: 102,
      author: 'unknown-metadata-human',
      body: 'post-migration unknown actor feedback',
      createdAt: '2026-07-20T00:00:02Z',
      commentType: 'conversation',
    });
    const fourth = await spec.admission.gate();
    assert.equal(fourth.run, true, 'post-migration unknown metadata remains fail-safe live');
    assert.deepEqual(
      fourth.workItems[0].signal.newComments.map((comment) => comment.id),
      [102],
    );
    await executeGate(spec, fourth);
    assert.equal(router.calls.length, 2);
    assert.equal(invokeTrigger.calls.length, 2);
  });

  it('keeps a genuinely new review decision live while comment history migrates state-only', async () => {
    const task = makePrTask();
    task.automationState.review = { lastCommentCursor: 100, lastDecisionCursor: 7 };
    const taskStore = makeTaskStore(task);
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      eventLog,
      reviewFeedbackRouter: router,
      invokeTrigger,
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async () => [
        {
          id: 100,
          author: 'pr-author',
          actorType: 'User',
          body: 'historical conversation',
          createdAt: '2026-07-18T00:00:01Z',
          commentType: 'conversation',
        },
      ],
      fetchReviews: async () => [
        {
          id: 8,
          author: 'community-human',
          actorType: 'User',
          state: 'APPROVED',
          body: 'new review decision',
          submittedAt: '2026-07-20T00:00:01Z',
        },
      ],
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(gate.workItems[0].signal.newComments, []);
    assert.deepEqual(
      gate.workItems[0].signal.newDecisions.map((review) => review.id),
      [8],
    );
    await executeGate(spec, gate);
    assert.equal(router.calls.length, 1);
    assert.equal(invokeTrigger.calls.length, 1);
    const state = taskStore.tasks.get('pr-task').automationState.review;
    assert.equal(state.lastConversationCommentCursor, 100);
    assert.equal(state.lastDecisionCursor, 8);
    assert.equal(state.commentCursorMigrationPending, false);
  });

  it('delivers PR author, third-party human, and unknown while exact self and Bot stay state-only', async () => {
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const comments = [
      {
        id: 1,
        author: 'tracker-self',
        actorType: 'User',
        body: 'echo',
        createdAt: '2026-07-20T00:00:01Z',
        commentType: 'conversation',
      },
      {
        id: 2,
        author: 'github-actions[bot]',
        actorType: 'Bot',
        body: 'automation',
        createdAt: '2026-07-20T00:00:02Z',
        commentType: 'conversation',
        authorAssociation: 'OWNER',
      },
      {
        id: 3,
        author: 'pr-author',
        actorType: 'User',
        body: 'author update',
        createdAt: '2026-07-20T00:00:03Z',
        commentType: 'conversation',
        authorAssociation: 'NONE',
      },
      {
        id: 4,
        author: 'reviewer',
        actorType: 'User',
        body: 'human review',
        createdAt: '2026-07-20T00:00:04Z',
        commentType: 'inline',
      },
      {
        id: 5,
        author: 'mystery',
        body: 'metadata missing',
        createdAt: '2026-07-20T00:00:05Z',
        commentType: 'conversation',
      },
    ];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      reviewFeedbackRouter: router,
      invokeTrigger,
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async () => comments,
      fetchReviews: async () => [],
      isEchoComment: (comment) => comment.author === 'tracker-self',
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(
      gate.workItems[0].signal.newComments.map((comment) => comment.id),
      [3, 4, 5],
    );
    assert.deepEqual(
      eventLog.events.map((event) => event.payload.commentId),
      [1, 2, 3, 4, 5],
    );
    assert.equal(eventLog.events.find((event) => event.payload.commentId === 2).payload.actorType, 'Bot');

    await executeGate(spec, gate);
    assert.equal(router.calls.length, 1);
    assert.equal(invokeTrigger.calls.length, 1);
  });

  it('keeps a Bot-only PR review batch durable while producing zero delivery or invocation', async () => {
    const taskStore = makeTaskStore(makePrTask());
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const holdCalls = [];
    const reviews = [
      {
        id: 10,
        author: 'chatgpt-codex-connector[bot]',
        actorType: 'Bot',
        state: 'COMMENTED',
        body: 'process review',
        submittedAt: '2026-07-20T00:00:10Z',
      },
    ];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      reviewFeedbackRouter: router,
      invokeTrigger,
      holdLifecycle: { retireSatisfiedWait: async (event) => holdCalls.push(event) },
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async () => [],
      fetchReviews: async () => reviews,
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, false);
    assert.equal(router.calls.length, 0);
    assert.equal(invokeTrigger.calls.length, 0);
    assert.equal(holdCalls.length, 0);
    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].payload.reviewId, 10);
    assert.equal(eventLog.events[0].payload.actorType, 'Bot');
    assert.equal(taskStore.tasks.get('pr-task').automationState.review.lastDecisionCursor, 10);
  });

  it('fails safe to raw delivery when a correlated cloud reviewer lacks actor type metadata', async () => {
    const task = makePrTask();
    task.automationState.eventWait = {
      v: 1,
      invocationId: 'invocation-1185',
      threadId: task.threadId,
      ownerCatId: task.ownerCatId,
      subjectKey: task.subjectKey,
      expectedSignal: 'review_posted',
      triggerHeadSha: 'head-1185',
      coverage: {
        status: 'covered',
        kind: 'github_review_trigger_eyes',
        triggerCommentId: 9001,
        observedAt: Date.parse('2026-07-20T00:00:00Z'),
      },
    };
    const taskStore = makeTaskStore(task);
    const router = makeRouter();
    const cloudObservations = [];
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      reviewFeedbackRouter: router,
      externalReviewCoordinator: {
        async recordCloud(observation, tracking) {
          cloudObservations.push({ observation, tracking });
          return { kind: 'state_only', reason: 'wake_policy_state_only' };
        },
      },
      now: () => Date.parse('2026-07-20T00:01:00Z'),
      fetchPrMetadata: async () => ({
        headSha: 'head-1185',
        prState: 'open',
        authorLogin: 'pr-author',
        authorType: 'User',
      }),
      fetchComments: async () => [],
      fetchReviews: async () => [
        {
          id: 11,
          author: 'chatgpt-codex-connector[bot]',
          state: 'COMMENTED',
          body: 'cloud result with unavailable actor metadata',
          submittedAt: '2026-07-20T00:00:11Z',
          commitId: 'head-1185',
        },
      ],
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(cloudObservations.length, 1, 'cloud state is still recorded');
    assert.equal(gate.run, true, 'unknown actor metadata fails safe to delivery');
    assert.deepEqual(
      gate.workItems[0].signal.newDecisions.map((review) => review.id),
      [11],
    );
  });

  it('preserves #1002 all-feedback behavior for Bot activity', async () => {
    const taskStore = makeTaskStore(makePrTask('all_feedback'));
    const router = makeRouter();
    const spec = createReviewFeedbackTaskSpec({
      taskStore,
      reviewFeedbackRouter: router,
      fetchPrMetadata: async () => ({ headSha: 'head', prState: 'open', authorLogin: 'author', authorType: 'User' }),
      fetchComments: async () => [
        {
          id: 20,
          author: 'automation',
          actorType: 'Bot',
          body: 'bot feedback',
          createdAt: '2026-07-20T00:00:20Z',
          commentType: 'conversation',
          authorAssociation: 'OWNER',
        },
      ],
      fetchReviews: async () => [],
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(
      gate.workItems[0].signal.newComments.map((comment) => comment.id),
      [20],
    );
  });
});

describe('IssueCommentTaskSpec actor-aware delivery parity', () => {
  it('delivers issue author, third-party human, and unknown while exact self and Bot stay state-only', async () => {
    const taskStore = makeTaskStore(makeIssueTask());
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const comments = [
      { id: 31, author: 'tracker-self', actorType: 'User', body: 'echo', createdAt: '2026-07-20T00:00:31Z' },
      {
        id: 32,
        author: 'dependabot[bot]',
        actorType: 'Bot',
        body: 'automation',
        createdAt: '2026-07-20T00:00:32Z',
        authorAssociation: 'OWNER',
      },
      {
        id: 33,
        author: 'issue-author',
        actorType: 'User',
        body: 'author update',
        createdAt: '2026-07-20T00:00:33Z',
        authorAssociation: 'NONE',
      },
      {
        id: 34,
        author: 'community-human',
        actorType: 'User',
        body: 'human response',
        createdAt: '2026-07-20T00:00:34Z',
      },
      { id: 35, author: 'mystery', body: 'unknown metadata', createdAt: '2026-07-20T00:00:35Z' },
    ];
    const spec = createIssueCommentTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      issueCommentRouter: router,
      invokeTrigger,
      fetchComments: async () => comments,
      fetchIssueState: async () => 'open',
      fetchIssueMetadata: async () => ({ state: 'open', authorLogin: 'issue-author', authorType: 'User' }),
      isEchoComment: (comment) => comment.author === 'tracker-self',
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(
      gate.workItems[0].signal.newComments.map((comment) => comment.id),
      [33, 34, 35],
    );
    assert.deepEqual(
      eventLog.events.map((event) => event.payload.commentId),
      [31, 32, 33, 34, 35],
    );
    assert.equal(eventLog.events.find((event) => event.payload.commentId === 32).payload.actorType, 'Bot');

    await executeGate(spec, gate);
    assert.equal(router.calls.length, 1);
    assert.equal(invokeTrigger.calls.length, 1);
  });

  it('keeps a Bot-only issue batch in event log and advances both cursors with zero wake', async () => {
    const taskStore = makeTaskStore(makeIssueTask());
    const eventLog = makeEventLog();
    const router = makeRouter();
    const invokeTrigger = makeInvokeTrigger();
    const holdCalls = [];
    const spec = createIssueCommentTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      issueCommentRouter: router,
      invokeTrigger,
      holdLifecycle: { retireSatisfiedWait: async (event) => holdCalls.push(event) },
      fetchComments: async () => [
        {
          id: 40,
          author: 'github-actions[bot]',
          actorType: 'Bot',
          body: 'automation',
          createdAt: '2026-07-20T00:00:40Z',
        },
      ],
      fetchIssueState: async () => 'open',
      fetchIssueMetadata: async () => ({ state: 'open', authorLogin: 'issue-author', authorType: 'User' }),
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, false);
    assert.equal(eventLog.events.length, 1);
    assert.equal(eventLog.events[0].payload.actorType, 'Bot');
    assert.equal(router.calls.length, 0);
    assert.equal(invokeTrigger.calls.length, 0);
    assert.equal(holdCalls.length, 0);
    const state = taskStore.tasks.get('issue-task').automationState.issue;
    assert.equal(state.lastCommentCursor, 40);
    assert.equal(state.lastDeliveredCursor, 40);
  });
});
