import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { GitHubWaitLifecycleService } = await import('../dist/domains/github-signals/GitHubWaitLifecycleService.js');
const { CiCdRouter } = await import('../dist/infrastructure/email/CiCdRouter.js');
const { createCiCdCheckTaskSpec } = await import('../dist/infrastructure/email/CiCdCheckTaskSpec.js');
const { ConflictRouter } = await import('../dist/infrastructure/email/ConflictRouter.js');
const { createConflictCheckTaskSpec } = await import('../dist/infrastructure/email/ConflictCheckTaskSpec.js');

const HEAD = 'aaaa1111';
const SUBJECT = 'pr:owner/repo#7';
const log = { info() {}, warn() {}, error() {} };

/** An outcome that was installed but never got out: the delivery outbox anyone's poll may flush. */
const pendingOutcome = {
  v: 1,
  outcomeId: `wait:${SUBJECT}:g1:matched`,
  generation: 1,
  subjectRef: SUBJECT,
  ownerFence: { kind: 'containing_task', generation: 1 },
  reason: 'matched',
  at: 200,
  delivery: 'pending',
  matched: [{ kind: 'pr_head_changed', delta: 'HEAD 9999999 → aaaa111' }],
  nextStep: 'Re-lock the exact HEAD.',
  renewal: 'rearmed',
};

function prAwait(when) {
  return {
    v: 1,
    generation: 2,
    subjectRef: SUBJECT,
    ownerFence: { kind: 'containing_task', generation: 2 },
    baseline: {
      capturedAt: 200,
      headSha: HEAD,
      review: { inlineCommentCursor: 10, conversationCommentCursor: 30, decisionCursor: 40 },
      ci: { bucket: 'pending', fingerprint: `${HEAD}:pending` },
      conflict: { mergeState: 'MERGEABLE' },
    },
    // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
    continuation: { when, then: 'Re-lock the exact HEAD.' },
    createdAt: 200,
  };
}

async function tracked(when) {
  const taskStore = new TaskStore();
  const messageStore = new MessageStore();
  const outboxWakes = [];
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: SUBJECT,
    threadId: 'thread_1',
    title: 'PR tracking: owner/repo#7',
    ownerCatId: 'opus',
    why: 'test',
    createdBy: 'opus',
    userId: 'user_1',
    automationState: {
      ci: { headSha: HEAD, lastFingerprint: `${HEAD}:pending`, lastBucket: 'pending' },
      conflict: { mergeState: 'MERGEABLE', lastFingerprint: `${HEAD}:MERGEABLE` },
      waitOutcome: pendingOutcome,
      await: prAwait(when),
    },
  });
  const lifecycle = new GitHubWaitLifecycleService({
    taskStore,
    deliveryDeps: { messageStore },
    log,
    wakeOwner: (delivered) => {
      outboxWakes.push(delivered.outcome.outcomeId);
    },
  });
  const contents = () => messageStore.getByThread('thread_1').map((message) => message.content);
  return { taskStore, task, lifecycle, outboxWakes, contents };
}

/*
 * #1392 AC-1: the outbox and the poll that flushes it are different things. Any collector's poll may
 * find outcome N still undelivered and flush it, but N belongs to the generation that produced it —
 * not to this poll. A collector that saw it as its own result would act on someone else's event.
 */
describe('#1392 a flushed outcome is never this poll’s result', () => {
  it('does not auto-resolve a conflict the wait never asked about', async () => {
    const { taskStore, task, lifecycle, outboxWakes, contents } = await tracked([{ kind: 'pr_head_changed' }]);
    const resolves = [];
    const wakes = [];
    const spec = createConflictCheckTaskSpec({
      taskStore,
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: HEAD }),
      conflictRouter: new ConflictRouter({
        taskStore,
        deliveryDeps: { messageStore: {} },
        waitLifecycle: lifecycle,
        log,
      }),
      autoExecutor: {
        resolve: async (repoFullName, prNumber) => {
          resolves.push(`${repoFullName}#${prNumber}`);
          return { kind: 'escalated', branch: 'feature', files: ['a.ts'] };
        },
      },
      invokeTrigger: { trigger: async (...args) => wakes.push(args[6].reason) },
      log,
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    await spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});

    assert.deepEqual(resolves, [], 'a wait that never asked about conflicts must not trigger a repo action');
    assert.deepEqual(wakes, [], 'and no conflict wake is owed either');
    assert.equal(contents().length, 1, 'the stranded outcome is still flushed');
    assert.match(contents()[0], /HEAD 9999999 → aaaa111/);
    assert.deepEqual(outboxWakes, [pendingOutcome.outcomeId], 'whoever flushed it owes its owner the wake');
    const after = (await taskStore.get(task.id)).automationState;
    assert.equal(after.await.generation, 2, 'the live wait is untouched');
    assert.equal(after.waitOutcome.delivery, 'delivered');
  });

  it('never reports a flushed outcome as this poll’s merge, and leaves the wait alive to retry', async () => {
    const { taskStore, task, lifecycle, outboxWakes, contents } = await tracked([{ kind: 'pr_ci_terminal' }]);
    const replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    let lostCloses = 3;
    taskStore.replaceAutomationStateIfGeneration = (taskId, input) => {
      if (input.automationState?.waitOutcome?.reason === 'subject_terminal' && lostCloses > 0) {
        lostCloses -= 1;
        return null;
      }
      return replace(taskId, input);
    };
    const wakes = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: new CiCdRouter({ taskStore, deliveryDeps: { messageStore: {} }, waitLifecycle: lifecycle, log }),
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: HEAD,
        prState: 'merged',
        aggregateBucket: 'pass',
        checks: [{ name: 'tests', bucket: 'pass' }],
      }),
      invokeTrigger: { trigger: async (...args) => wakes.push({ reason: args[6].reason, content: args[3] }) },
      log,
    });
    const poll = async () => {
      const gate = await spec.admission.gate();
      for (const item of gate.run ? gate.workItems : []) {
        await spec.run.execute(item.signal, item.subjectKey, {});
      }
      return gate;
    };

    await poll();

    assert.equal(lostCloses, 0, 'every attempt to close the wait lost its race');
    assert.deepEqual(wakes, [], 'a merge nothing recorded is not a merge to report');
    const contended = await taskStore.get(task.id);
    assert.notEqual(contended.status, 'done', 'the close did not happen, so the task is still tracked');
    assert.equal(contended.automationState.await.generation, 2, 'and its wait is still live to retry');
    assert.equal(contents().length, 1, 'only the flushed outcome reached the thread');
    assert.deepEqual(outboxWakes, [pendingOutcome.outcomeId]);

    await poll();

    assert.deepEqual(
      wakes.map((wake) => wake.reason),
      ['github_pr_merged'],
      'the retry closes the wait and reports the merge itself',
    );
    assert.match(wakes[0].content, /merged/);
    assert.doesNotMatch(wakes[0].content, /HEAD 9999999/, 'never the flushed body');
    assert.equal((await taskStore.get(task.id)).status, 'done');
  });
});
