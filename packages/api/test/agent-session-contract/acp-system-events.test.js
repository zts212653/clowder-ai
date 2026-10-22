import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeSingleCat } from '../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { collect, options } from './fake-session-provider.js';

function bridgeFor(messages) {
  return new AgentSessionBridgeService({
    catId: 'codex',
    resolveHostSession: () => ({ sessionId: 'host' }),
    provider: new AcpSessionProvider({
      catId: 'codex',
      service: {
        async *invoke() {
          yield* messages;
        },
      },
    }),
  });
}

// Use the production ACP service: thinking buffering/flush, capacity warnings
// and usage transformation all run before the session adapter sees a message.
async function nativeMessages() {
  const client = {
    isAlive: true,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    newSession: async () => ({ sessionId: 'native' }),
    async *promptStream() {
      for (const update of [
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '完整思考：' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先检查容量。' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
        { sessionUpdate: 'provider_capacity_signal', message: 'No capacity available (429)', timestamp: Date.now() },
        { sessionUpdate: 'plan', content: { type: 'text', text: '完整计划' } },
        { sessionUpdate: 'usage_update', used: 85000, size: 100000 },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '流末尾的思考' } },
      ])
        yield { sessionId: 'native', update };
      return 'end_turn';
    },
  };
  const service = new AcpAgentService({
    catId: 'codex',
    providerName: 'Fixture ACP',
    projectRoot: '/tmp',
    poolKey: { projectPath: '/tmp', providerProfile: 'test' },
    pool: { acquire: async () => ({ client, release() {} }) },
  });
  return collect(service.invoke('hello'));
}

const visibleFields = ({ type, content, targetCatId, routing, metadata }) => ({
  type,
  content,
  targetCatId,
  routing,
  usage: metadata?.usage,
});

test('real ACP transformer and capacity warning retain full bodies through adapter and bridge', async () => {
  const native = await nativeMessages();
  const messages = await collect(bridgeFor(native).invoke('hello', options()));
  const system = native.filter((m) => ['system_info', 'provider_signal', 'agent_loop'].includes(m.type));
  assert.deepEqual(
    system.filter((m) => m.type === 'system_info').map((m) => JSON.parse(m.content)),
    [
      { type: 'thinking', text: '完整思考：先检查容量。' },
      { type: 'plan', text: '完整计划' },
      { type: 'thinking', text: '流末尾的思考' },
    ],
  );
  const warning = system.find((m) => m.type === 'provider_signal');
  assert.ok(warning);
  assert.equal(
    JSON.parse(warning.content).message,
    'Fixture ACP 服务端容量不足，正在重试 (No capacity available (429))',
  );
  assert.deepEqual(
    messages
      .filter((m) => ['system_info', 'provider_signal', 'agent_loop'].includes(m.type))
      .map(({ type, content }) => ({ type, content })),
    system.map(({ type, content }) => ({ type, content })),
  );
  assert.deepEqual(
    messages.find((m) => m.type === 'agent_loop').metadata.usage,
    system.find((m) => m.type === 'agent_loop').metadata.usage,
  );
  assert.equal(
    messages.some((m) => m.type === 'status'),
    false,
  );

  const delivered = await collect(
    invokeSingleCat(
      {
        registry: { create: () => ({ invocationId: 'inv', callbackToken: 'fixture' }) },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          store: async () => {},
          resolveWorkingDirectory: () => '/tmp',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3162',
      },
      {
        catId: 'codex',
        service: bridgeFor(native),
        prompt: 'hello',
        userId: 'user',
        threadId: 'thread',
        isLastCat: true,
      },
    ),
  );
  for (const original of system.filter((m) => m.type !== 'agent_loop')) {
    assert.ok(delivered.some((m) => m.type === 'system_info' && m.content === original.content));
  }
  assert.equal(
    delivered.some((m) => ['agent_loop', 'provider_signal', 'liveness_signal'].includes(m.type)),
    false,
  );
});

test('all auxiliary message types preserve content, usage and handoff routing through the bridge', async () => {
  const source = ['system_info', 'provider_signal', 'liveness_signal', 'agent_loop', 'status', 'a2a_handoff'].map(
    (type) => ({
      type,
      catId: 'codex',
      timestamp: 1,
      content: `${type}完整正文`,
      metadata: { provider: 'acp', model: 'fixture', usage: { inputTokens: 12 } },
      ...(type === 'a2a_handoff' ? { targetCatId: 'opus', routing: { mode: 'parallel', index: 1, total: 2 } } : {}),
    }),
  );
  const messages = await collect(bridgeFor(source).invoke('hello', options()));
  assert.deepEqual(messages.slice(0, -1).map(visibleFields), source.map(visibleFields));
  assert.equal(messages.at(-1).type, 'done');
});
