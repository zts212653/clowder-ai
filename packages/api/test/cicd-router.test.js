import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { MemoryWaitLifecycleEventLog } = await import('../dist/domains/ball-custody/WaitLifecycleEventLog.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { DistillationCheckpoint, InMemoryOpportunityStore } = await import(
  '../dist/infrastructure/distillation/DistillationCheckpoint.js'
);
const { CiCdRouter, buildCiMessageContent } = await import('../dist/infrastructure/email/CiCdRouter.js');

function awaitState(when) {
  return {
    ci: { headSha: 'aaa1111', lastFingerprint: 'aaa1111:pending', lastBucket: 'pending' },
    await: {
      v: 1,
      generation: 1,
      subjectRef: 'pr:owner/repo#7',
      ownerFence: { kind: 'containing_task', generation: 1 },
      baseline: {
        capturedAt: 100,
        headSha: 'aaa1111',
        ci: { bucket: 'pending', fingerprint: 'aaa1111:pending' },
      },
      continuation: {
        when,
        // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
        then: 'Continue the owned step.',
      },
      expiresAt: 10_000,
      createdAt: 100,
    },
  };
}

async function setup(when) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    eventLog: new MemoryWaitLifecycleEventLog(),
    now: () => 500,
    log: { info() {}, warn() {}, error() {} },
  });
  const task = when
    ? await taskStore.create({
        kind: 'pr_tracking',
        subjectKey: 'pr:owner/repo#7',
        threadId: 'thread_1',
        title: 'F280 PR wait',
        ownerCatId: 'codex-sol',
        why: 'test',
        createdBy: 'codex-sol',
        userId: 'user_1',
        automationState: awaitState(when),
      })
    : null;
  const events = [];
  const router = new CiCdRouter({
    taskStore,
    deliveryDeps: { messageStore },
    waitLifecycle: lifecycle,
    log: { info() {}, warn() {}, error() {} },
    onPrLifecycle: (event) => {
      events.push(event);
      return { idempotencyKey: event.idempotencyKey };
    },
  });
  return { taskStore, messageStore, task, router, events };
}

function poll(overrides = {}) {
  return {
    repoFullName: 'owner/repo',
    prNumber: 7,
    headSha: 'aaa1111',
    prState: 'open',
    aggregateBucket: 'pass',
    checks: [{ name: 'tests', bucket: 'pass' }],
    ...overrides,
  };
}

describe('CiCdRouter F280 typed waits', () => {
  test('unregistered PR is state-only', async () => {
    const { router } = await setup(null);
    assert.equal((await router.route(poll())).kind, 'skipped');
  });

  test('CI pass wakes an explicit CI waiter exactly once', async () => {
    const { router, messageStore } = await setup([{ kind: 'pr_ci_terminal' }]);
    const first = await router.route(poll());
    const replay = await router.route(poll());
    assert.equal(first.kind, 'notified');
    assert.notEqual(replay.kind, 'notified');
    assert.match(first.content, /CI pending → pass/);
    assert.equal(messageStore.getByThread('thread_1').length, 1);
  });

  test('CI pass does not wake a reviewer waiting only for a new HEAD', async () => {
    const { router, messageStore, taskStore, task } = await setup([{ kind: 'pr_head_changed' }]);
    assert.equal((await router.route(poll())).kind, 'skipped');
    assert.equal(messageStore.getByThread('thread_1').length, 0);
    assert.equal((await taskStore.get(task.id)).automationState.ci.lastBucket, 'pass');
  });

  test('merged PR consumes the wait, marks done, and emits world truth once', async () => {
    const { router, taskStore, task, events } = await setup([{ kind: 'pr_head_changed' }]);
    const result = await router.route(poll({ prState: 'merged', aggregateBucket: 'pending' }));
    assert.equal(result.kind, 'lifecycle');
    assert.equal((await taskStore.get(task.id)).status, 'done');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'merge');
    assert.equal(events[0].ref, 'pr:owner/repo#7');
    assert.deepEqual(events[0].attribution, { kind: 'managed_unattributed' });
  });

  test('merge world truth carries the task-bound private managed-work identity', async () => {
    const { router, taskStore, task, events } = await setup([{ kind: 'pr_head_changed' }]);
    await taskStore.bindManagedWorkBinding(task.id, {
      workId: 'wrk_work_a',
      attemptId: 'wat_work_a_1',
    });

    await router.route(poll({ prState: 'merged', aggregateBucket: 'pending' }));

    assert.deepEqual(events[0].attribution, {
      kind: 'managed_attributed',
      binding: { workId: 'wrk_work_a', attemptId: 'wat_work_a_1' },
    });
  });

  test('terminal delivery failure recovers every merge world-truth effect exactly once after restart', async () => {
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
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'F280 Phase B PR wait',
      ownerCatId: 'codex-sol',
      why: 'test terminal recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: awaitState([{ kind: 'pr_head_changed' }]),
    });
    const lifecycleEvents = [];
    const distillationEvents = [];
    const communityEvents = [];
    const projectedEvents = [];
    const seenCommunityEvents = new Set();
    const eventLog = {
      append: async (event) => {
        const appended = !seenCommunityEvents.has(event.sourceEventId);
        seenCommunityEvents.add(event.sourceEventId);
        if (appended) communityEvents.push(event);
        return { appended, sequence: appended ? communityEvents.length - 1 : -1 };
      },
      read: async (subjectKey) => communityEvents.filter((event) => event.subjectKey === subjectKey),
      listSubjects: async () => [...new Set(communityEvents.map((event) => event.subjectKey))],
    };
    const options = () => ({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle: new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog: new MemoryWaitLifecycleEventLog(),
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      }),
      log: { info() {}, warn() {}, error() {} },
      onPrLifecycle: (event) => {
        lifecycleEvents.push(event);
        return { idempotencyKey: event.idempotencyKey };
      },
      distillationCheckpoint: {
        onFeatPhaseClose: async (event) => {
          distillationEvents.push(event);
          return { fired: true, sourceId: `feat-phase-close:${event.featureId}:${event.phaseLabel}` };
        },
      },
      eventLog,
      projector: {
        rebuild: async (subjectKey) => {
          projectedEvents.splice(0, projectedEvents.length, ...(await eventLog.read(subjectKey)));
        },
      },
    });
    const terminalPoll = poll({ prState: 'merged', aggregateBucket: 'pending' });

    await assert.rejects(() => new CiCdRouter(options()).route(terminalPoll), /connector unavailable/);
    assert.equal((await taskStore.get(task.id)).automationState.waitOutcome.delivery, 'pending');

    await new CiCdRouter(options()).route(terminalPoll);
    await new CiCdRouter(options()).route(terminalPoll);

    assert.equal(lifecycleEvents.length, 1);
    assert.equal(distillationEvents.length, 1);
    assert.equal(communityEvents.length, 1);
    assert.equal(projectedEvents.length, 1);
  });

  test('concurrent recovery and a lost receipt still commit each terminal effect exactly once', async () => {
    const taskStore = new TaskStore();
    const messageStore = {
      append: async () => {
        throw new Error('connector unavailable');
      },
    };
    const task = await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'F280 Phase B PR wait',
      ownerCatId: 'codex-sol',
      why: 'test concurrent terminal recovery',
      createdBy: 'codex-sol',
      userId: 'user_1',
      automationState: awaitState([{ kind: 'pr_head_changed' }]),
    });
    const lifecycleCommits = new Set();
    let lifecycleInvocations = 0;
    let releaseLifecycle;
    const lifecycleRelease = new Promise((resolve) => {
      releaseLifecycle = resolve;
    });
    let bothLifecycleWorkersEntered;
    const lifecycleWorkersEntered = new Promise((resolve) => {
      bothLifecycleWorkersEntered = resolve;
    });
    const opportunityStore = new InMemoryOpportunityStore();
    const distillationCheckpoint = new DistillationCheckpoint({
      opportunityStore,
      log: { info() {}, warn() {} },
    });
    const communityEvents = [];
    const seenCommunityEvents = new Set();
    const eventLog = {
      append: async (event) => {
        const appended = !seenCommunityEvents.has(event.sourceEventId);
        seenCommunityEvents.add(event.sourceEventId);
        if (appended) communityEvents.push(event);
        return { appended, sequence: appended ? communityEvents.length - 1 : -1 };
      },
      read: async (subjectKey) => communityEvents.filter((event) => event.subjectKey === subjectKey),
      listSubjects: async () => [...new Set(communityEvents.map((event) => event.subjectKey))],
    };
    const projection = { appliedEventCount: 0 };
    const projector = {
      apply: async () => {
        projection.appliedEventCount += 1;
      },
      rebuild: async (subjectKey) => {
        projection.appliedEventCount = (await eventLog.read(subjectKey)).length;
      },
    };
    const options = () => ({
      taskStore,
      deliveryDeps: { messageStore },
      waitLifecycle: new GitHubWaitLifecycleService({
        taskStore,
        deliveryDeps: { messageStore },
        eventLog: new MemoryWaitLifecycleEventLog(),
        now: () => 500,
        log: { info() {}, warn() {}, error() {} },
      }),
      log: { info() {}, warn() {}, error() {} },
      onPrLifecycle: async (event) => {
        lifecycleInvocations += 1;
        if (lifecycleInvocations === 2) bothLifecycleWorkersEntered();
        if (lifecycleInvocations <= 2) await lifecycleRelease;
        const idempotencyKey = event.idempotencyKey ?? `legacy-call:${lifecycleInvocations}`;
        lifecycleCommits.add(idempotencyKey);
        return { idempotencyKey };
      },
      distillationCheckpoint,
      eventLog,
      projector,
    });
    const terminalPoll = poll({ prState: 'merged', aggregateBucket: 'pending' });

    const first = new CiCdRouter(options()).route(terminalPoll);
    const second = new CiCdRouter(options()).route(terminalPoll);
    await lifecycleWorkersEntered;
    releaseLifecycle();
    await Promise.allSettled([first, second]);

    const stored = await taskStore.get(task.id);
    const { terminalEffects: _lostReceipt, ...ciWithoutReceipt } = stored.automationState.ci;
    await taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: stored.automationState.waitOutcome.generation,
      expectedUpdatedAt: stored.updatedAt,
      automationState: { ...stored.automationState, ci: ciWithoutReceipt },
      status: 'done',
    });
    await assert.rejects(() => new CiCdRouter(options()).route(terminalPoll), /connector unavailable/);

    assert.equal(lifecycleCommits.size, 1);
    assert.equal((await opportunityStore.listPending()).length, 1);
    assert.equal(communityEvents.length, 1);
    assert.equal(projection.appliedEventCount, 1);
  });
});

describe('CI preview renderer', () => {
  test('never includes source descriptions or legacy caller prose', () => {
    const content = buildCiMessageContent(
      poll({
        aggregateBucket: 'fail',
        checks: [{ name: 'tests', bucket: 'fail', description: 'SOURCE_SECRET' }],
      }),
      'LEGACY_SECRET',
    );
    assert.equal(content.includes('SOURCE_SECRET'), false);
    assert.equal(content.includes('LEGACY_SECRET'), false);
  });
});
