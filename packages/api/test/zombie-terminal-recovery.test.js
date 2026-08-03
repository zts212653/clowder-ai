import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createZombieTerminalRecovery } = await import(
  '../dist/domains/cats/services/agents/invocation/ZombieTerminalRecovery.js'
);

function makeRecovery() {
  const completionCalls = [];
  const recovery = createZombieTerminalRecovery({
    queueProcessor: {
      onReconciledZombieComplete: async (...args) => completionCalls.push(args),
    },
    log: { info: () => {}, warn: () => {} },
  });
  return { recovery, completionCalls };
}

describe('F194 zombie terminal recovery composition', () => {
  it('routes the reconciled terminal through the owner-fenced QueueProcessor boundary', async () => {
    const { recovery, completionCalls } = makeRecovery();

    await recovery({
      invocationId: 'inv-zombie',
      threadId: 'thread-zombie',
      catId: 'codex-sol',
      targetCats: ['codex-sol', 'opus'],
      status: 'failed',
    });

    assert.deepEqual(completionCalls, [['thread-zombie', ['codex-sol', 'opus'], 'inv-zombie']]);
  });

  it('skips owner-fenced recovery when the reconciled parent has no durable target cats', async () => {
    const { recovery, completionCalls } = makeRecovery();

    await recovery({
      invocationId: 'inv-zombie',
      threadId: 'thread-zombie',
      catId: null,
      targetCats: [],
      status: 'failed',
    });

    assert.equal(completionCalls.length, 0);
  });
});
