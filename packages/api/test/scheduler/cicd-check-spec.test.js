import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');

async function trackedTask(store) {
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
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 100, headSha: 'aaa' },
        continuation: {
          when: [{ kind: 'pr_ci_terminal' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'continue',
        },
        expiresAt: 10_000,
        createdAt: 100,
      },
    },
  });
}

describe('CI scheduler F280 adapter', () => {
  test('gate emits one work item per active PR wait', async () => {
    const taskStore = new TaskStore();
    await trackedTask(taskStore);
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaa',
        prState: 'open',
        aggregateBucket: 'pending',
        checks: [],
      }),
      log: { info() {}, warn() {}, error() {} },
    });
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
  });

  test('gate keeps a terminal task reachable until durable world-truth effects complete', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTask(taskStore);
    await taskStore.update(task.id, { status: 'done' });
    await taskStore.patchAutomationState(task.id, { ci: { prState: 'merged' } });
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatus: async () => null,
      log: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await spec.admission.gate()).run, true);

    await taskStore.patchAutomationState(task.id, {
      ci: { terminalEffects: { prState: 'merged', completedAt: 500 } },
    });
    assert.equal((await spec.admission.gate()).run, false);
  });

  test('only a notified typed outcome invokes the owner', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTask(taskStore);
    const calls = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async () => ({
          kind: 'notified',
          threadId: 'thread_1',
          catId: 'codex-sol',
          messageId: 'msg_1',
          bucket: 'pass',
          content: 'compact wait',
        }),
      },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaa',
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      }),
      invokeTrigger: { trigger: async (...args) => calls.push(args) },
      log: { info() {}, warn() {}, error() {} },
    });
    await spec.run.execute({ task, repoFullName: 'owner/repo', prNumber: 7 }, task.subjectKey, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][6].reason, 'github_wait_satisfied');
  });
});
