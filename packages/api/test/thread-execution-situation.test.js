import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createThreadExecutionSituationSource } = await import(
  '../dist/domains/cats/services/agents/invocation/thread-execution-situation.js'
);

function exactFixture() {
  const sourceMessage = {
    id: 'message-source',
    threadId: 'thread-1',
    from: { kind: 'agent', catId: 'opus' },
    lifecycle: {
      kind: 'input',
      orderKey: '0000000000100:message-source',
      dispatchRefs: [{ targetId: 'kimi', phase: 'dispatched', statusMessageId: 'message-response' }],
    },
  };
  const responseMessage = {
    id: 'message-response',
    threadId: 'thread-1',
    from: { kind: 'agent', catId: 'kimi' },
    lifecycle: {
      kind: 'response',
      orderKey: '0000000000200:message-response',
      invocationId: 'invocation-kimi',
      targetId: 'kimi',
      inputEntryIds: ['entry-kimi'],
      inputMessageIds: ['message-source'],
      status: 'processing',
      startedAt: 200,
    },
  };
  const activeRun = {
    threadId: 'thread-1',
    targetId: 'kimi',
    invocationId: 'invocation-kimi',
    responseMessageId: 'message-response',
    inputEntryIds: ['entry-kimi'],
    inputMessageIds: ['message-source'],
    privateInputEntryIds: [],
    startedAt: 200,
  };
  return { sourceMessage, responseMessage, activeRun };
}

function sourceFor(messages, activeRuns) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return createThreadExecutionSituationSource({
    messageStore: {
      async getById(messageId) {
        return byId.get(messageId);
      },
    },
    listActiveRuns: () => activeRuns,
  });
}

describe('thread execution situation', () => {
  test('projects one active member only when source, response, and active run identities all agree', async () => {
    const { sourceMessage, responseMessage, activeRun } = exactFixture();
    const situation = await sourceFor([sourceMessage, responseMessage], [activeRun]).resolve('thread-1');

    assert.deepEqual(situation, {
      kind: 'thread_execution_situation.v1',
      complete: true,
      activeRuns: [
        {
          phase: 'processing',
          targetId: 'kimi',
          invocationId: 'invocation-kimi',
          responseMessageId: 'message-response',
          startedAt: 200,
          sources: [{ messageId: 'message-source', from: { kind: 'agent', catId: 'opus' } }],
        },
      ],
    });
  });

  test('fails closed instead of treating an unjoined runtime witness as active', async () => {
    const { sourceMessage, responseMessage, activeRun } = exactFixture();
    const mismatchedRun = { ...activeRun, invocationId: 'different-invocation' };
    const situation = await sourceFor([sourceMessage, responseMessage], [mismatchedRun]).resolve('thread-1');

    assert.deepEqual(situation, {
      kind: 'thread_execution_situation.v1',
      complete: false,
      activeRuns: [],
    });
  });

  test('fails closed on ambiguous source-to-target dispatch identity', async () => {
    const { sourceMessage, responseMessage, activeRun } = exactFixture();
    sourceMessage.lifecycle.dispatchRefs.push({ targetId: 'kimi', phase: 'assigned' });
    const situation = await sourceFor([sourceMessage, responseMessage], [activeRun]).resolve('thread-1');

    assert.equal(situation.complete, false);
    assert.deepEqual(situation.activeRuns, []);
  });

  test('fails closed rather than joining lifecycle records across thread boundaries', async () => {
    const { sourceMessage, responseMessage, activeRun } = exactFixture();
    for (const messages of [
      [{ ...sourceMessage, threadId: 'another-thread' }, responseMessage],
      [sourceMessage, { ...responseMessage, threadId: 'another-thread' }],
    ]) {
      const situation = await sourceFor(messages, [activeRun]).resolve('thread-1');
      assert.deepEqual(situation, {
        kind: 'thread_execution_situation.v1',
        complete: false,
        activeRuns: [],
      });
    }
  });

  test('does not invent a public situation claim for private-only execution', async () => {
    const { responseMessage, activeRun } = exactFixture();
    const privateRun = { ...activeRun, inputMessageIds: [] };
    const situation = await sourceFor([responseMessage], [privateRun]).resolve('thread-1');

    assert.deepEqual(situation, {
      kind: 'thread_execution_situation.v1',
      complete: true,
      activeRuns: [],
    });
  });
});
