import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

function createMockRegistry() {
  let counter = 0;
  return {
    create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  const rows = [];
  let sequence = 0;
  return {
    append: (message) => {
      const stored = {
        ...message,
        id: `msg-${String(++sequence).padStart(6, '0')}`,
        threadId: message.threadId ?? 'default',
      };
      rows.push(stored);
      return stored;
    },
    getByThread: () => [],
    getByThreadBefore: () => [],
    getById: (id) => rows.find((message) => message.id === id) ?? null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getBefore: () => [],
    getByThreadAfter: () => [],
    deleteByThread: () => 0,
    updateExtra: () => null,
    _rows: rows,
  };
}

function createMockThreadStore(routingPolicy, participantsWithActivity = []) {
  return {
    get: async (threadId) => ({ id: threadId, participants: [], routingPolicy }),
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => participantsWithActivity,
    addParticipants: async () => {},
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    consumeMentionRoutingFeedback: () => null,
  };
}

function createMockAgentService(catId, response = 'response') {
  return {
    invoke: mock.fn(async function* (_prompt, options) {
      yield { type: 'session_init', catId, sessionId: options?.sessionId ?? `${catId}-session`, timestamp: Date.now() };
      yield { type: 'text', catId, content: response, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    }),
  };
}

async function createRouter({ routingPolicy, participantsWithActivity, services = {} } = {}) {
  const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const agentRegistry = new AgentRegistry();
  for (const [catId, service] of Object.entries({
    'opus-5': createMockAgentService('opus-5', 'Opus 5 response'),
    codex: createMockAgentService('codex', 'Codex response'),
    ...services,
  })) {
    agentRegistry.register(catId, service);
  }
  return new AgentRouter({
    agentRegistry,
    registry: createMockRegistry(),
    messageStore: createMockMessageStore(),
    threadStore: createMockThreadStore(routingPolicy, participantsWithActivity),
  });
}

describe('AgentRouter successor routing', () => {
  test('executes the configured default successor when no mention is present', async () => {
    const router = await createRouter();
    const result = await router.resolveTargetsAndIntent('继续刚才的讨论', 'thread-default');
    assert.deepEqual(result.targetCats, ['opus-5']);

    const streamed = [];
    for await (const message of router.route('user-1', '继续刚才的讨论', 'thread-default')) streamed.push(message);
    assert.ok(streamed.some((message) => message.catId === 'opus-5'));
  });

  test('maps historical prefer and avoid policy entries through the explicit successor', async () => {
    const preferred = await createRouter({
      routingPolicy: { v: 1, scopes: { architecture: { preferCats: ['opus'] } } },
    });
    const preferredResult = await preferred.resolveTargetsAndIntent('这个架构 tradeoff 怎么选', 'thread-policy');
    assert.equal(preferredResult.targetCats[0], 'opus-5');

    const avoided = await createRouter({
      routingPolicy: { v: 1, scopes: { review: { avoidCats: ['opus'] } } },
    });
    const avoidedResult = await avoided.resolveTargetsAndIntent('请 review 这次改动', 'thread-policy');
    assert.equal(avoidedResult.targetCats[0], 'codex');
    assert.ok(!avoidedResult.targetCats.includes('opus-5'));
  });

  test('keeps an explicit disabled @opus mention fail-closed with a successor warning', async () => {
    const router = await createRouter();
    const result = await router.resolveTargetsAndIntent('@opus 请确认架构方案', 'thread-explicit');
    assert.deepEqual(result.targetCats, []);
    assert.equal(result.routing_warnings[0]?.kind, 'cat_disabled');
    assert.equal(result.routing_warnings[0]?.catId, 'opus');
    assert.equal(result.routing_warnings[0]?.alternatives[0]?.catId, 'opus-5');
  });

  test('preserves last-replier priority when a historical participant has a successor', async () => {
    const router = await createRouter({
      participantsWithActivity: [
        { catId: 'opus', lastMessageAt: 200, messageCount: 2, lastResponseHealthy: true },
        { catId: 'codex', lastMessageAt: 100, messageCount: 1, lastResponseHealthy: true },
      ],
    });

    const peeked = await router.resolveTargetsAndIntent('continue the discussion', 'thread-participant');
    assert.deepEqual(peeked.targetCats, ['opus-5']);

    const persisted = await router.resolveTargetsAndIntent('continue the discussion', 'thread-participant', {
      persist: true,
    });
    assert.deepEqual(persisted.targetCats, ['opus-5']);
  });

  test('normalizes pre-resolved disabled targets before executing a service', async () => {
    const legacyService = createMockAgentService('opus', 'Legacy response');
    const successorService = createMockAgentService('opus-5', 'Opus 5 response');
    const router = await createRouter({ services: { opus: legacyService, 'opus-5': successorService } });

    const streamed = [];
    for await (const message of router.routeExecution(
      'user-1',
      'system-generated architecture request',
      'thread-pre-resolved',
      'msg-pre-resolved',
      ['opus'],
      { intent: 'execute', explicit: false, promptTags: [] },
    )) {
      streamed.push(message);
    }

    assert.equal(legacyService.invoke.mock.callCount(), 0, 'disabled legacy service must not execute');
    assert.equal(successorService.invoke.mock.callCount(), 1, 'configured successor must execute exactly once');
    assert.ok(streamed.some((message) => message.catId === 'opus-5'));
  });

  test('does not choose an unrelated fallback when an implicit default has no successor', async () => {
    const { clearRuntimeDefaultCatId, setRuntimeDefaultCatId } = await import('../dist/config/cat-config-loader.js');
    setRuntimeDefaultCatId('antigravity');
    try {
      const router = await createRouter();
      const result = await router.resolveTargetsAndIntent('continue without an explicit target', 'thread-no-default');
      assert.deepEqual(result.targetCats, []);
    } finally {
      clearRuntimeDefaultCatId();
    }
  });
});
