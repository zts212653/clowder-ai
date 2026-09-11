import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { assembleIncrementalContext: assembleRaw } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);

function assemble(messages, viewerCatId = 'codex') {
  return assembleRaw(
    {
      services: {},
      invocationDeps: {},
      messageStore: { getByThreadAfter: async () => messages },
      deliveryCursorStore: { getCursor: async () => undefined },
    },
    'user-1',
    'thread-1',
    viewerCatId,
    undefined,
    'debug',
    { effectiveMaxContextTokens: 500_000 },
  );
}

function emptyTerminalResponse(status) {
  return {
    id: `response-${status}`,
    threadId: 'thread-1',
    userId: 'user-1',
    from: { kind: 'agent', catId: 'opus' },
    catId: 'opus',
    content: '',
    mentions: [],
    timestamp: 100,
    deliveryStatus: status === 'canceled' ? 'canceled' : 'delivered',
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      status,
      startedAt: 50,
      completedAt: 100,
    },
  };
}

describe('lifecycle response incremental context', () => {
  test('projects an empty canceled peer response as explicit readable context', async () => {
    const result = await assemble([emptyTerminalResponse('canceled')]);

    assert.ok(result.contextText.includes('已停止回复。'), result.contextText);
    assert.deepEqual(result.projectedMessageIds, ['response-canceled']);
  });

  test('projects an empty interrupted peer response as explicit readable context', async () => {
    const result = await assemble([emptyTerminalResponse('interrupted')]);

    assert.ok(result.contextText.includes('回复已中断。'), result.contextText);
  });
});
