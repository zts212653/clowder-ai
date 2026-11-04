import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveMembers } from '../src/domains/plugin/external-runtime/package-staging.js';
import { projectThreadMessages } from '../src/domains/plugin/host-surface/plugin-thread-projections.js';

test('Windows tar listings retain canonical package member names', () => {
  assert.deepEqual(archiveMembers('package/plugin.yaml\r\npackage/assets/icon.svg\r\n'), [
    'package/plugin.yaml',
    'package/assets/icon.svg',
  ]);
});

test('ordinary plugin history exposes durable response status and exact input association', async () => {
  const row = {
    id: 'reply',
    threadId: 'thread',
    userId: 'owner',
    catId: 'codex',
    type: 'assistant',
    content: '# 标题\n\n## 问题摘要\n报告',
    timestamp: 20,
    lifecycle: {
      kind: 'response',
      invocationId: 'turn',
      inputMessageIds: ['request'],
      status: 'completed',
      startedAt: 10,
      completedAt: 20,
    },
    metadata: { callbackToken: 'private-canary' },
  };
  const store = { getByThread: async () => [row] };
  const messages = await projectThreadMessages(
    store as unknown as Parameters<typeof projectThreadMessages>[0],
    'thread',
    'owner',
    { limit: 20 },
  );
  assert.deepEqual(Reflect.get(messages[0]!, 'response'), {
    executionId: 'turn',
    inputMessageIds: ['request'],
    status: 'completed',
    startedAt: 10,
    completedAt: 20,
  });
  assert.ok(!JSON.stringify(messages).includes('private-canary'));
});
