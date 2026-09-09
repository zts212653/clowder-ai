import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { MemoryWaitLifecycleEventLog } = await import('../dist/domains/ball-custody/WaitLifecycleEventLog.js');
const { IssueWaitMigrationService } = await import('../dist/domains/ball-custody/IssueWaitMigrationService.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
const { canonicalizeGitHubIssueWaitPredicates, matchGitHubWaitPredicates } = await import(
  '../dist/domains/github-signals/GitHubWaitPredicateCatalog.js'
);

function issueAwaitState(when = [{ kind: 'issue_comment_added' }]) {
  return {
    issue: {
      lastCommentCursor: 40,
      lastDeliveredCursor: 40,
      issueState: 'open',
    },
    await: {
      v: 1,
      generation: 2,
      subjectRef: 'issue:owner/repo#17',
      ownerFence: { kind: 'containing_task', generation: 2 },
      baseline: {
        capturedAt: 100,
        issue: {
          lastCommentCursor: 40,
          state: 'open',
          authorLogin: 'issue-author',
        },
      },
      continuation: {
        when,
        // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
        then: 'Inspect the issue author reply.',
      },
      expiresAt: 10_000,
      createdAt: 100,
      provenance: 'explicit_registration',
    },
  };
}

describe('F280 Phase C issue predicate contract', () => {
  it('accepts only the closed issue predicate catalog and rejects mixed PR predicates', () => {
    assert.deepEqual(canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_comment_added' }]), [
      { kind: 'issue_comment_added' },
    ]);
    // F280 section 4b removed issue_author_commented: prose/role-shaped issue predicates were
    // the second pipeline that let a body classifier short-circuit ahead of the echo check.
    assert.throws(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_author_commented' }]));
    assert.throws(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'issue_closed' }]));
    assert.throws(() => canonicalizeGitHubIssueWaitPredicates([{ kind: 'pr_head_changed' }]));
  });

  it('matches exact issue facts after the frozen baseline without parsing comment bodies', () => {
    const baseline = {
      capturedAt: 100,
      issue: { lastCommentCursor: 40, state: 'open', authorLogin: 'issue-author' },
    };
    const facts = {
      issue: {
        state: 'open',
        comments: [
          { id: 41, author: 'automation-bot', sourceRef: 'github:issue-comment:41' },
          { id: 42, author: 'issue-author', sourceRef: 'github:issue-comment:42' },
        ],
      },
    };

    const anyComment = matchGitHubWaitPredicates([{ kind: 'issue_comment_added' }], baseline, facts);
    assert.equal(anyComment.length, 2);
    assert.deepEqual(
      anyComment.map((match) => match.kind),
      ['issue_comment_added', 'issue_comment_added'],
    );
    assert.equal(JSON.stringify(anyComment).includes('comment body'), false);
  });
});

describe('F280 Phase C issue wait lifecycle', () => {
  it('keeps already-seen issue comments state-only, then consumes a new one exactly once', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const eventLog = new MemoryWaitLifecycleEventLog();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#17',
      threadId: 'thread_issue',
      title: 'Issue tracking: owner/repo#17',
      ownerCatId: 'codex-sol',
      why: 'test issue wait',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: issueAwaitState(),
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      eventLog,
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });

    // The frozen baseline is the ONLY thing that decides "already seen" — not who wrote it.
    const alreadySeen = await lifecycle.observe({
      taskId: task.id,
      facts: {
        issue: {
          state: 'open',
          comments: [{ id: 40, author: 'automation-bot', sourceRef: 'github:issue-comment:40' }],
        },
      },
      collectorPatch: {
        issue: { lastCommentCursor: 40, lastDeliveredCursor: 40, issueState: 'open' },
      },
    });
    assert.equal(alreadySeen.kind, 'state_only');
    assert.equal(messageStore.getByThread('thread_issue').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastCommentCursor, 40);

    const matched = await lifecycle.observe({
      taskId: task.id,
      facts: {
        issue: {
          state: 'open',
          comments: [{ id: 42, author: 'issue-author', sourceRef: 'github:issue-comment:42' }],
        },
      },
      collectorPatch: {
        issue: { lastCommentCursor: 42, lastDeliveredCursor: 42, issueState: 'open' },
      },
    });
    const replay = await lifecycle.observe({
      taskId: task.id,
      facts: {
        issue: {
          state: 'open',
          comments: [{ id: 42, author: 'issue-author', sourceRef: 'github:issue-comment:42' }],
        },
      },
    });

    assert.equal(matched.kind, 'notified');
    assert.notEqual(replay.kind, 'notified');
    assert.match(matched.content, /Issue wait satisfied/);
    assert.match(matched.content, /issue comment #42 added by issue-author/);
    assert.doesNotMatch(matched.content, /UNTRUSTED EXTERNAL CONTENT/);
    assert.deepEqual(messageStore.getByThread('thread_issue')[0].source?.meta?.waitContinuationCarrier, {
      v: 1,
      waitId: task.id,
      outcomeId: 'wait:issue:owner/repo#17:g2:matched',
      ownerFence: { kind: 'containing_task', generation: 2 },
    });
    assert.equal((await eventLog.read(task.id))[0].waitKind, 'github_issue');
  });

  it('delivers a final same-poll comment together with the closed issue state', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const waitEventLog = new MemoryWaitLifecycleEventLog();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#17',
      threadId: 'thread_issue_final_comment',
      title: 'Issue tracking: owner/repo#17',
      ownerCatId: 'codex-sol',
      why: 'deliver the final comment before tracking terminates',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: issueAwaitState(),
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      eventLog: waitEventLog,
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    const triggered = [];
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: { route: async () => ({ kind: 'skipped', reason: 'legacy path unused' }) },
      waitLifecycle: lifecycle,
      fetchComments: async () => [
        {
          id: 42,
          author: 'issue-author',
          body: 'One last important detail.',
          createdAt: '2026-09-08T00:00:00Z',
        },
      ],
      fetchIssueState: async () => 'closed',
      eventLog: {
        append: async () => ({ appended: true, sequence: 1 }),
      },
      invokeTrigger: {
        trigger: async (_threadId, _catId, _userId, content) => {
          triggered.push(content);
          return 'dispatched';
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.equal(triggered.length, 1);
    assert.match(triggered[0], /Issue state: closed/);
    assert.match(triggered[0], /issue comment #42 by issue-author/);
    assert.equal((await taskStore.get(task.id)).status, 'done');
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastDeliveredCursor, 42);
  });

  it('retries a durable terminal issue outcome after its first connector delivery fails', async () => {
    const taskStore = new TaskStore();
    const storedMessages = new MessageStore();
    let failDelivery = true;
    const messageStore = {
      append: async (input) => {
        if (failDelivery) {
          failDelivery = false;
          throw new Error('connector unavailable');
        }
        return storedMessages.append(input);
      },
    };
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#17',
      threadId: 'thread_issue_terminal_retry',
      title: 'Issue tracking: owner/repo#17',
      ownerCatId: 'codex-sol',
      why: 'retry a durable terminal issue outcome',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: issueAwaitState(),
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      eventLog: new MemoryWaitLifecycleEventLog(),
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    const triggered = [];
    let metadataReads = 0;
    let commentReads = 0;
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: { route: async () => ({ kind: 'skipped', reason: 'legacy path unused' }) },
      waitLifecycle: lifecycle,
      fetchComments: async () => {
        commentReads += 1;
        if (commentReads > 1) throw new Error('GitHub comments unavailable during local recovery');
        return [
          {
            id: 42,
            author: 'issue-author',
            body: 'The final comment must survive a connector outage.',
            createdAt: '2026-09-08T00:00:00Z',
          },
        ];
      },
      fetchIssueState: async () => {
        metadataReads += 1;
        if (metadataReads > 1) throw new Error('GitHub issue state unavailable during local recovery');
        return 'closed';
      },
      invokeTrigger: {
        trigger: async (_threadId, _catId, _userId, content) => {
          triggered.push(content);
          return 'dispatched';
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const firstGate = await spec.admission.gate();
    await assert.rejects(
      spec.run.execute(firstGate.workItems[0].signal, firstGate.workItems[0].subjectKey, {}),
      /connector unavailable/,
    );
    const failed = await taskStore.get(task.id);
    assert.equal(failed.status, 'done');
    assert.equal(failed.automationState.waitOutcome.delivery, 'pending');

    const retryGate = await spec.admission.gate();
    assert.equal(retryGate.run, true);
    assert.equal(retryGate.workItems.length, 1);
    await spec.run.execute(retryGate.workItems[0].signal, retryGate.workItems[0].subjectKey, {});

    assert.equal(triggered.length, 1);
    assert.match(triggered[0], /Issue state: closed/);
    assert.equal(metadataReads, 1, 'recovery must not re-read issue metadata');
    assert.equal(commentReads, 1, 'recovery must not re-read issue comments');
    assert.equal((await taskStore.get(task.id)).automationState.waitOutcome.delivery, 'delivered');
  });

  it('keeps a closed issue active when its final comment was not persisted', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#17',
      threadId: 'thread_issue_failed_final_comment',
      title: 'Issue tracking: owner/repo#17',
      ownerCatId: 'codex-sol',
      why: 'retry the final comment before tracking terminates',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: issueAwaitState(),
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });
    const triggered = [];
    const persistedCommentIds = new Set();
    let failFinalCommentOnce = true;
    const spec = createIssueCommentTaskSpec({
      taskStore,
      issueCommentRouter: { route: async () => ({ kind: 'skipped', reason: 'legacy path unused' }) },
      waitLifecycle: lifecycle,
      fetchComments: async () => [
        {
          id: 41,
          author: 'issue-author',
          body: 'This comment persisted successfully.',
          createdAt: '2026-09-08T00:00:00Z',
        },
        {
          id: 42,
          author: 'issue-author',
          body: 'This comment must land before the terminal notification.',
          createdAt: '2026-09-08T00:01:00Z',
        },
      ],
      fetchIssueState: async () => 'closed',
      eventLog: {
        append: async (event) => {
          const commentId = event.payload.commentId;
          if (commentId === 42 && failFinalCommentOnce) {
            failFinalCommentOnce = false;
            throw new Error('transient event-log failure');
          }
          const appended = !persistedCommentIds.has(commentId);
          persistedCommentIds.add(commentId);
          return { appended, sequence: persistedCommentIds.size };
        },
      },
      invokeTrigger: {
        trigger: async (_threadId, _catId, _userId, content) => {
          triggered.push(content);
          return 'dispatched';
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const gate = await spec.admission.gate();

    assert.equal(gate.run, false, 'an unpersisted comment must not enter terminal delivery');
    assert.equal(triggered.length, 0);
    assert.notEqual((await taskStore.get(task.id)).status, 'done', 'the next poll must be allowed to retry');
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastCommentCursor, 41);

    const retryGate = await spec.admission.gate();
    assert.equal(retryGate.run, true);
    assert.equal(retryGate.workItems.length, 1, 'the complete persisted batch must become terminal delivery');
    await spec.run.execute(retryGate.workItems[0].signal, retryGate.workItems[0].subjectKey, {});

    assert.equal(triggered.length, 1);
    assert.match(triggered[0], /Issue state: closed/);
    assert.match(triggered[0], /issue comment #41 by issue-author/);
    assert.match(triggered[0], /issue comment #42 by issue-author/);
    assert.equal((await taskStore.get(task.id)).status, 'done');
    assert.equal((await taskStore.get(task.id)).automationState.issue.lastDeliveredCursor, 42);
  });

  it('stops a collector-only issue task when the GitHub subject becomes terminal', async () => {
    const taskStore = new TaskStore();
    const messageStore = new MessageStore();
    const task = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#19',
      threadId: 'thread_issue_collector',
      title: 'Issue tracking: owner/repo#19',
      ownerCatId: 'codex-sol',
      why: 'collect community issue facts without an active owner wait',
      createdBy: 'system',
      userId: 'user_1',
      automationState: {
        issue: { lastCommentCursor: 7, lastDeliveredCursor: 7, issueState: 'open' },
      },
    });
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: { messageStore },
      now: () => 500,
      log: { info() {}, warn() {}, error() {} },
    });

    const result = await lifecycle.observe({
      taskId: task.id,
      facts: { issue: { state: 'closed', comments: [] } },
      collectorPatch: {
        issue: { lastCommentCursor: 7, lastDeliveredCursor: 7, issueState: 'closed' },
      },
      subjectState: 'closed',
    });

    const terminal = await taskStore.get(task.id);
    assert.deepEqual(result, {
      kind: 'state_only',
      reason: 'subject_terminal_without_active_wait',
      observationEvaluated: true,
    });
    assert.equal(terminal.status, 'done');
    assert.equal(terminal.automationState.issue.issueState, 'closed');
    assert.equal(messageStore.getByThread('thread_issue_collector').length, 0);
  });
});

describe('F280 Phase C legacy issue migration', () => {
  it('cleans completed legacy issue state without parsing the subject or reading GitHub', async () => {
    const taskStore = new TaskStore();
    const done = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'historic-malformed-issue-subject',
      threadId: 'thread_done',
      title: 'Historical issue tracking task',
      ownerCatId: 'codex-sol',
      why: 'legacy completed issue wait',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        wakePolicy: 'human_participant_activity',
        trackingInstructions: 'preserve as audit context',
        issue: { lastCommentCursor: 21, lastDeliveredCursor: 20, issueState: 'closed' },
        closedAt: 900,
      },
    });
    await taskStore.update(done.id, { status: 'done' });
    let baselineReads = 0;
    const migration = new IssueWaitMigrationService({
      taskStore,
      readBaseline: async () => {
        baselineReads += 1;
        throw new Error('github unavailable');
      },
      log: { info() {}, warn() {} },
    });

    assert.deepEqual(await migration.migrateAll(), { migratedActive: 0, cleanedDone: 1, alreadyCurrent: 0 });
    assert.equal(baselineReads, 0);
    const cleaned = await taskStore.get(done.id);
    assert.deepEqual(cleaned.automationState, {
      issue: { lastCommentCursor: 21, lastDeliveredCursor: 20, issueState: 'closed' },
      closedAt: 900,
    });
    assert.equal(cleaned.why.includes('preserve as audit context'), true);
  });

  it('reclassifies a completed task when the subject is re-registered during cleanup', async () => {
    const taskStore = new TaskStore();
    const done = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#17',
      threadId: 'thread_done',
      title: 'Historical issue tracking task',
      ownerCatId: 'codex-sol',
      why: 'legacy completed issue wait',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        wakePolicy: 'human_participant_activity',
        trackingInstructions: 'legacy wait re-registered while startup migration runs',
        issue: { lastCommentCursor: 21, lastDeliveredCursor: 20, issueState: 'open' },
      },
    });
    await taskStore.update(done.id, { status: 'done' });

    const replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    let injectedReregistration = false;
    taskStore.replaceAutomationStateIfGeneration = async (taskId, input) => {
      if (!injectedReregistration) {
        injectedReregistration = true;
        const delayMs = Math.max(1, (input.expectedUpdatedAt ?? Date.now()) - Date.now() + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await taskStore.upsertBySubject({
          kind: 'issue_tracking',
          subjectKey: 'issue:owner/repo#17',
          threadId: 'thread_new',
          title: 'Re-registered issue tracking task',
          ownerCatId: 'codex-sol',
          why: 'new active registration',
          createdBy: 'codex-sol',
          userId: 'user_1',
        });
      }
      return replace(taskId, input);
    };

    let baselineReads = 0;
    const migration = new IssueWaitMigrationService({
      taskStore,
      now: () => 1_000,
      readBaseline: async () => {
        baselineReads += 1;
        return {
          baseline: {
            capturedAt: 1_000,
            issue: { lastCommentCursor: 22, state: 'open', authorLogin: 'issue-author' },
          },
          collectorState: {
            issue: { lastCommentCursor: 22, lastDeliveredCursor: 22, issueState: 'open' },
          },
        };
      },
      log: { info() {}, warn() {} },
    });

    assert.deepEqual(await migration.migrateAll(), { migratedActive: 1, cleanedDone: 0, alreadyCurrent: 0 });
    assert.equal(baselineReads, 1);
    const migrated = await taskStore.get(done.id);
    assert.equal(migrated.threadId, 'thread_new');
    assert.equal(migrated.status, 'todo');
    assert.equal(migrated.automationState.await.subjectRef, 'issue:owner/repo#17');
    assert.equal(migrated.automationState.await.baseline.issue.lastCommentCursor, 22);
  });

  it('atomically replaces legacy actor policy and prose with typed waits and frozen baselines', async () => {
    const taskStore = new TaskStore();
    const active = await taskStore.create({
      kind: 'issue_tracking',
      subjectKey: 'issue:owner/repo#18',
      threadId: 'thread_active',
      title: 'Issue tracking: owner/repo#18',
      ownerCatId: 'codex-sol',
      why: 'legacy issue wait',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: {
        wakePolicy: 'human_participant_activity',
        trackingInstructions: 'legacy prose must become audit only',
        issue: { lastCommentCursor: 12, lastDeliveredCursor: 12, issueState: 'open' },
      },
    });

    const migration = new IssueWaitMigrationService({
      taskStore,
      now: () => 1_000,
      readBaseline: async () => ({
        baseline: {
          capturedAt: 1_000,
          issue: { lastCommentCursor: 15, state: 'open', authorLogin: 'issue-author' },
        },
        collectorState: {
          issue: { lastCommentCursor: 15, lastDeliveredCursor: 15, issueState: 'open' },
        },
      }),
      log: { info() {}, warn() {} },
    });

    assert.deepEqual(await migration.migrateAll(), { migratedActive: 1, cleanedDone: 0, alreadyCurrent: 0 });
    const migrated = await taskStore.get(active.id);
    assert.deepEqual(migrated.automationState.await.continuation.when, [{ kind: 'issue_comment_added' }]);
    assert.equal(migrated.automationState.await.baseline.issue.lastCommentCursor, 15);
    assert.equal(migrated.why.includes('legacy prose must become audit only'), true);
    assert.equal(Object.hasOwn(migrated.automationState, 'wakePolicy'), false);
    assert.equal(Object.hasOwn(migrated.automationState, 'trackingInstructions'), false);
  });
});
