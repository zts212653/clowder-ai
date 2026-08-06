import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { decideTrackingWake } = await import('../dist/domains/community/community-delivery-policy.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');

function makeTaskStore(task) {
  const tasks = new Map([[task.id, structuredClone(task)]]);
  return {
    tasks,
    async listByKind(kind) {
      return [...tasks.values()].filter((candidate) => candidate.kind === kind && candidate.status !== 'done');
    },
    async update(id, patch) {
      const current = tasks.get(id);
      if (current) tasks.set(id, { ...current, ...patch });
    },
    async patchAutomationState(id, patch) {
      const current = tasks.get(id);
      if (!current) return null;
      const automationState = { ...current.automationState };
      for (const [key, value] of Object.entries(patch)) {
        automationState[key] =
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(automationState[key] ?? {}), ...value }
            : value;
      }
      const next = { ...current, automationState };
      tasks.set(id, next);
      return next;
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

function makeEventLog() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push(structuredClone(event));
      return { appended: true, sequence: events.length - 1 };
    },
  };
}

const log = { info() {}, warn() {}, error() {} };

describe('F140 Phase-C issue actor-aware wake policy', () => {
  const cases = [
    {
      name: 'subject author is a deliverable human participant',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'issue-author',
        actorType: 'User',
        subjectAuthorLogin: 'ISSUE-AUTHOR',
      },
      expected: { decision: 'deliver', reason: 'subject_author' },
    },
    {
      name: 'third-party human delivers regardless of repository association',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'reviewer',
        actorType: 'User',
        subjectAuthorLogin: 'issue-author',
        authorAssociation: 'OWNER',
      },
      expected: { decision: 'deliver', reason: 'human_participant' },
    },
    {
      name: 'Bot is state-only even when association says OWNER',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'automation',
        actorType: 'Bot',
        subjectAuthorLogin: 'issue-author',
        authorAssociation: 'OWNER',
      },
      expected: { decision: 'state_only', reason: 'automation_actor' },
    },
    {
      name: 'unknown actor metadata fails safe to delivery',
      input: {
        wakePolicy: 'human_participant_activity',
        actorLogin: 'mystery',
        subjectAuthorLogin: 'issue-author',
      },
      expected: { decision: 'deliver', reason: 'unknown_actor' },
    },
    {
      name: 'all_feedback preserves legacy Bot delivery',
      input: {
        wakePolicy: 'all_feedback',
        actorLogin: 'automation',
        actorType: 'Bot',
        subjectAuthorLogin: 'issue-author',
      },
      expected: { decision: 'deliver', reason: 'all_feedback' },
    },
  ];

  for (const fixture of cases) {
    it(fixture.name, () => {
      assert.deepEqual(decideTrackingWake(fixture.input), fixture.expected);
    });
  }

  it('delivers issue author, third-party human, and unknown while echo and Bot stay state-only', async () => {
    const taskStore = makeTaskStore(makeIssueTask());
    const eventLog = makeEventLog();
    const routerCalls = [];
    const triggerCalls = [];
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
      issueCommentRouter: {
        async route(signal, tracking) {
          routerCalls.push({ signal, tracking });
          return {
            kind: 'notified',
            threadId: tracking.threadId,
            catId: tracking.catId,
            messageId: 'message-1',
            content: 'fixture',
          };
        },
      },
      invokeTrigger: {
        async trigger(...args) {
          triggerCalls.push(args);
        },
      },
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
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(routerCalls.length, 1);
    assert.equal(triggerCalls.length, 1);
  });

  it('keeps a Bot-only issue batch durable and advances cursors with zero wake', async () => {
    const taskStore = makeTaskStore(makeIssueTask());
    const eventLog = makeEventLog();
    const spec = createIssueCommentTaskSpec({
      taskStore,
      eventLog,
      projector: { async apply() {} },
      issueCommentRouter: {
        async route() {
          throw new Error('Bot-only batch must not route');
        },
      },
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
    const state = taskStore.tasks.get('issue-task').automationState.issue;
    assert.equal(state.lastCommentCursor, 40);
    assert.equal(state.lastDeliveredCursor, 40);
  });
});
