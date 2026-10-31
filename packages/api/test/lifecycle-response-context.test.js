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

function emptyTerminalResponse(status, reason) {
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
      ...(reason ? { reason } : {}),
    },
  };
}

describe('lifecycle response incremental context', () => {
  test('projects an empty canceled peer response as explicit readable context', async () => {
    const result = await assemble([emptyTerminalResponse('canceled')]);

    assert.ok(result.contextText.includes('已停止回复。'), result.contextText);
    assert.deepEqual(result.projectedMessageIds, ['response-canceled']);
  });

  test('#1398: explains that a user-canceled own response was stopped by the user', async () => {
    const result = await assemble([emptyTerminalResponse('canceled', 'user_cancel')], 'opus');

    assert.ok(result.contextText.includes('用户已取消该回复'), result.contextText);
    assert.equal(result.contextText.includes('上一轮'), false, result.contextText);
    assert.equal(result.contextText.includes('harness'), false, result.contextText);
  });

  test('projects an empty interrupted peer response as explicit readable context', async () => {
    const result = await assemble([emptyTerminalResponse('interrupted')]);

    assert.ok(result.contextText.includes('回复已中断。'), result.contextText);
  });

  test('#1398: projects the current cat own empty interrupted response as lifecycle context', async () => {
    const result = await assemble([emptyTerminalResponse('interrupted')], 'opus');

    assert.ok(result.contextText.includes('回复已中断。'), result.contextText);
    assert.deepEqual(result.projectedMessageIds, ['response-interrupted']);
  });

  test('#1398: explains that a preempted response was interrupted by a later message', async () => {
    const result = await assemble([emptyTerminalResponse('interrupted', 'preempted')], 'opus');

    assert.ok(result.contextText.includes('该回复已被后续消息中断'), result.contextText);
  });

  test('#1398: does not replay the current cat own rich response as an empty lifecycle marker', async () => {
    const message = emptyTerminalResponse('completed');
    message.extra = {
      rich: {
        blocks: [{ id: 'card-1', v: 1, kind: 'card', title: '已呈现的卡片' }],
      },
    };

    const result = await assemble([message], 'opus');

    assert.equal(result.contextText.includes('已呈现的卡片'), false, result.contextText);
    assert.deepEqual(result.projectedMessageIds, []);
  });
});
