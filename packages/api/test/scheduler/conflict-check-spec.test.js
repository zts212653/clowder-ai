import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');

describe('conflict scheduler F280 adapter', () => {
  test('collects merge state for active PR tasks', async () => {
    const taskStore = new TaskStore();
    await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'PR wait',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
    });
    const spec = createConflictCheckTaskSpec({
      taskStore,
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'aaa' }),
      conflictRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      log: { info() {}, warn() {}, error() {} },
    });
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.signal.mergeState, 'MERGEABLE');
  });

  test('does not invoke when typed wait remains state-only', async () => {
    const calls = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: { route: async () => ({ kind: 'skipped', reason: 'predicates_not_matched' }) },
      invokeTrigger: { trigger: async (...args) => calls.push(args) },
      log: { info() {}, warn() {}, error() {} },
    });
    await spec.run.execute(
      {
        signal: { repoFullName: 'owner/repo', prNumber: 7, headSha: 'aaa', mergeState: 'CONFLICTING' },
        task: { userId: 'user_1' },
      },
      'pr:owner/repo#7',
      {},
    );
    assert.equal(calls.length, 0);
  });
});
