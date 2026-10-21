import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import { PluginConversationHostAdapter } from '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/plugin-conversation-host-adapter.js';

test('a package refusal for a revoked conversation maps to needs-binding without changing the stored route', async () => {
  const route = 'https://chatgpt.com/c/conversation-9';
  const fallbacks = [];
  const calls = [];
  const adapter = new PluginConversationHostAdapter({
    provider: 'chatgpt',
    registry: {
      current: () => ({
        pluginId: 'official.companion.personal-chrome',
        contribution: { appendMessage: { method: 'append' } },
        async attempt(method, input) {
          calls.push({ method, input });
          return { status: 'returned', value: { status: 'failed', errorCode: 'BOUND_CONVERSATION_MISMATCH' } };
        },
      }),
    },
  });
  const bridge = new CloudInvokeBridge({
    hostAdapter: adapter,
    emitFallback: async (fallback) => {
      fallbacks.push(fallback);
    },
    threadStore: {
      get: async () => ({ id: 'thread_t1', title: 'demo', participants: ['gpt-pro'] }),
      getCloudCatBindings: async () => ({ 'gpt-pro': route }),
      updateCloudCatBinding: async () => assert.fail('a refused append must not rewrite the route'),
    },
  });
  const outcome = await bridge.dispatchInternal({
    catId: 'gpt-pro',
    threadId: 'thread_t1',
    userId: 'alice',
    threadTitle: 'demo',
    participants: [{ catId: 'gpt-pro', handle: '@gpt-pro' }],
    calledBy: 'opus-47',
    intent: 'help me',
    sourceMessageId: 'source-message-h4',
  });
  assert.equal(outcome.kind, 'fallback');
  assert.equal(outcome.reason, 'needs-binding');
  assert.deepEqual(
    fallbacks.map(({ reason }) => reason),
    ['needs-binding'],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.conversationId, 'conversation-9');
});
