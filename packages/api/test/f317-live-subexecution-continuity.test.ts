import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexSubexecutionTracker } from '../src/domains/cats/services/agents/providers/CodexSubexecutionTracker.js';

test('Live keeps admitted child provenance across a new root turn and records a resumed child turn', async () => {
  const options = {
    binding: { threadId: 'root', turnId: 'owner-1' },
    readThread: async () => null,
    emitChildTurnStarts: true,
    now: () => 1000,
  };
  let tracker = createCodexSubexecutionTracker(options);
  const start = await tracker.observe({
    method: 'item/started',
    params: {
      threadId: 'root',
      turnId: 'owner-1',
      item: {
        type: 'subAgentActivity',
        id: 'activity',
        kind: 'started',
        agentThreadId: 'child',
        agentPath: '/root/reader',
      },
    },
  });
  assert.equal(start.event?.root_turn_id, 'owner-1');
  await tracker.observe({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-1' } } });
  const liveTracker = tracker as typeof tracker & { advanceRootTurn?(turnId: string): void };
  if (liveTracker.advanceRootTurn) liveTracker.advanceRootTurn('owner-2');
  else tracker = createCodexSubexecutionTracker({ ...options, binding: { threadId: 'root', turnId: 'owner-2' } });
  const late = await tracker.observe({
    method: 'item/completed',
    params: {
      threadId: 'child',
      turnId: 'child-1',
      item: { type: 'agentMessage', id: 'result-1', phase: 'final_answer', text: 'old request result' },
    },
  });
  assert.equal(late.scope, 'child', 'new owner topic cannot erase the child of the original request');
  assert.equal(late.event?.root_turn_id, 'owner-1');
  await tracker.observe({
    method: 'turn/completed',
    params: { threadId: 'child', turn: { id: 'child-1', status: 'completed' } },
  });
  const resumed = await tracker.observe({
    method: 'turn/started',
    params: { threadId: 'child', turn: { id: 'child-2' } },
  });
  assert.equal(resumed.event?.stage, 'started');
  assert.equal(resumed.event?.turn_id, 'child-2');
  assert.equal(resumed.event?.root_turn_id, 'owner-1');
  const replay = await tracker.observe({
    method: 'turn/started',
    params: { threadId: 'child', turn: { id: 'child-2' } },
  });
  assert.equal(replay.event, undefined);
  const denied = await tracker.observe({
    method: 'item/completed',
    params: {
      threadId: 'child',
      turnId: 'child-2',
      item: {
        type: 'mcpToolCall',
        id: 'denied-tool',
        tool: 'cat_cafe_list_tasks',
        status: 'failed',
        error: { message: 'Native tool admission is unavailable for this exact turn' },
      },
    },
  });
  assert.match(denied.event?.content ?? '', /native_turn_admission_unavailable/);
  assert.equal(denied.event?.message_phase, 'unknown', 'a tool denial is not a child final');
  const foreign = await tracker.observe({
    method: 'turn/completed',
    params: { threadId: 'other', turn: { id: 'child-2', status: 'completed' } },
  });
  assert.equal(foreign.scope, 'foreign');
});
