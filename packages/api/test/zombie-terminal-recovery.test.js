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

  it('F117 KD-21: settles each child turn response in scope before the queue moves on', async () => {
    const order = [];
    const warnings = [];
    const turn = (invocationId, overrides = {}) => ({
      invocationId,
      parentInvocationId: 'inv-zombie',
      threadId: 'thread-zombie',
      userId: 'user-zombie',
      catId: 'opus',
      executionKind: 'ordinary',
      startedAt: 10,
      status: 'interrupted',
      ...overrides,
    });
    const recovery = createZombieTerminalRecovery({
      queueProcessor: {
        onReconciledZombieComplete: async () => order.push('queue'),
      },
      log: { info: () => {}, warn: (obj) => warnings.push(obj) },
      childResponses: {
        listChildTurns: (executionId) => {
          order.push(`list:${executionId}`);
          return [
            turn('child-a'),
            turn('child-failing'),
            turn('child-other-thread', { threadId: 'thread-elsewhere' }),
            turn('child-other-user', { userId: 'user-elsewhere' }),
            turn('child-b'),
          ];
        },
        settle: async (child) => {
          order.push(`settle:${child.invocationId}`);
          if (child.invocationId === 'child-failing') throw new Error('commit rejected');
        },
      },
    });

    await recovery({
      invocationId: 'inv-zombie',
      userId: 'user-zombie',
      threadId: 'thread-zombie',
      catId: 'opus',
      targetCats: ['opus'],
      status: 'failed',
    });

    assert.deepEqual(order, ['list:inv-zombie', 'settle:child-a', 'settle:child-failing', 'settle:child-b', 'queue']);
    assert.deepEqual(
      warnings.map((warning) => warning.invocationId),
      ['child-failing'],
    );
  });
});
