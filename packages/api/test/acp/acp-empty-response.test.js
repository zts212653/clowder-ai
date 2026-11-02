import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { appendTestLifecycleResponseSource } from '../helpers/message-from-fixtures.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { AcpProtocolError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

function fixture({
  events = [],
  elapsedMs = 8_000,
  failure,
  freshEvents = events,
  stopReason = 'end_turn',
  onEnd,
} = {}) {
  let now = 1_000_000;
  const clock = mock.method(Date, 'now', () => now);
  const prompts = [];
  const client = {
    recentCapacitySignal: null,
    async newSession() {
      return { sessionId: 'fresh' };
    },
    async loadSession(sessionId) {
      return { sessionId };
    },
    async setSessionConfigOption() {},
    cancelSession() {},
    async *promptStream(sessionId) {
      prompts.push(sessionId);
      for (const update of sessionId === 'fresh' ? freshEvents : events) yield { sessionId, update };
      now += elapsedMs;
      onEnd?.(sessionId);
      if (failure) throw failure;
      return typeof stopReason === 'function' ? stopReason(sessionId) : stopReason;
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  const service = new AcpAgentService({
    catId: 'kimi',
    providerName: 'kimi',
    modelName: 'kimi-acp',
    projectRoot: '/tmp',
    poolKey: { projectPath: '/tmp', providerProfile: 'empty-response-test' },
    pool: {
      async acquire() {
        return { client, release() {} };
      },
      rememberSession() {},
    },
  });
  return { service, prompts, cleanup: () => clock.mock.restore() };
}

// Kimi maps non-auth provider failures to end_turn without exposing the cause.
// Exercise the real adapter; advance a fake clock instead of waiting eight seconds.
test('slow resumed ACP end_turn without output is a failure, never silent success', async () => {
  const f = fixture();
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /未返回.*回复.*工具调用/);
    assert.match(error.error, /未提供.*原因/);
    assert.deepEqual(f.prompts, ['resumed'], 'slow empty turns must not be replayed');
    assert.equal(messages.at(-1).type, 'done');
  } finally {
    f.cleanup();
  }
});

test('usage-only ACP updates do not establish a successful reply', async () => {
  const f = fixture({ events: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }] });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello'));
    assert.equal(messages.find((message) => message.type === 'error')?.errorCode, 'empty_response');
    assert.deepEqual(f.prompts, ['fresh']);
  } finally {
    f.cleanup();
  }
});

test('an empty fresh-session retry also fails, while a successful retry stays successful', async () => {
  for (const freshEvents of [
    [],
    [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } }],
  ]) {
    const f = fixture({ elapsedMs: 100, freshEvents });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
      assert.deepEqual(f.prompts, ['resumed', 'fresh']);
      assert.equal(
        messages.some((message) => message.type === 'error'),
        freshEvents.length === 0,
      );
      if (freshEvents.length === 0)
        assert.equal(messages.find((message) => message.type === 'error').errorCode, 'empty_response');
    } finally {
      f.cleanup();
    }
  }
});

test('explicit non-success ACP stop reasons are failures even after partial output', async () => {
  for (const stopReason of ['refusal', 'cancelled', 'max_tokens', 'max_turn_requests']) {
    const f = fixture({
      stopReason,
      events: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }],
    });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello'));
      assert.equal(messages.find((message) => message.type === 'text')?.content, 'partial');
      assert.match(messages.find((message) => message.type === 'error')?.error, new RegExp(stopReason));
      assert.deepEqual(f.prompts, ['fresh'], 'terminal failures must not be replayed');
    } finally {
      f.cleanup();
    }
  }
});

test('a tool-only reply is valid output and an explicit upstream error retains its cause', async () => {
  for (const input of [
    { events: [{ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', kind: 'read', status: 'pending' }] },
    { failure: new AcpProtocolError(-32603, 'Internal error', { error: 'Insufficient quota' }) },
  ]) {
    const f = fixture(input);
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello'));
      const error = messages.find((message) => message.type === 'error');
      if (input.failure) assert.match(error.error, /Insufficient quota/);
      else {
        assert.equal(error, undefined);
        assert.ok(messages.some((message) => message.type === 'tool_use'));
      }
    } finally {
      f.cleanup();
    }
  }
});

test('a user cancel is never reported as an empty or failed turn', async () => {
  const partial = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }];
  const cases = [
    { name: 'cancelled with no output', input: { stopReason: 'cancelled' }, text: undefined },
    { name: 'cancelled after partial output', input: { stopReason: 'cancelled', events: partial }, text: 'partial' },
    {
      name: 'cancelled during the fresh-session retry',
      input: { elapsedMs: 100, stopReason: (id) => (id === 'fresh' ? 'cancelled' : 'end_turn') },
      options: { sessionId: 'resumed' },
      abortOn: 'fresh',
    },
  ];
  for (const { name, input, options, text, abortOn } of cases) {
    const controller = new AbortController();
    const f = fixture({ ...input, onEnd: (id) => (abortOn === undefined || id === abortOn) && controller.abort() });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello', { ...options, signal: controller.signal }));
      assert.equal(
        messages.some((message) => message.type === 'error'),
        false,
        `${name}: a user-requested stop must not surface as an error`,
      );
      assert.equal(messages.at(-1).type, 'done', name);
      assert.equal(messages.find((message) => message.type === 'text')?.content, text, name);
    } finally {
      f.cleanup();
    }
  }
});

test('empty ACP output persists a failed response and its explanation through both route strategies', async () => {
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { routeSerial } = await import('../../dist/domains/cats/services/agents/routing/route-serial.js');
  const { routeParallel } = await import('../../dist/domains/cats/services/agents/routing/route-parallel.js');
  for (const route of [routeSerial, routeParallel]) {
    const f = fixture();
    try {
      const { deps } = routingJourneyDeps(undefined, undefined, f.service);
      deps.services = { kimi: f.service };
      deps.messageStore = new MessageStore();
      let responseId;
      const persistenceContext = { failed: false, errors: [] };
      await Array.fromAsync(
        route(deps, ['kimi'], 'hello', 'user1', 'thread1', {
          persistenceContext,
          onLifecycleInvocationStarted: async (input) => {
            const response = await appendTestLifecycleResponseSource(deps.messageStore, {
              invocationId: input.invocationId,
              catId: input.catId,
              threadId: input.threadId,
              userId: input.userId,
              timestamp: input.startedAt,
            });
            responseId = response.id;
            return { responseMessageId: response.id, priorFrontierMessageId: null };
          },
        }),
      );
      assert.deepEqual(persistenceContext.errors, []);
      const persisted = await deps.messageStore.getById(responseId);
      assert.equal(persisted.lifecycle.status, 'failed');
      assert.match(persisted.content, /未返回.*回复.*工具调用/);
      assert.match(persisted.content, /未提供.*原因/);
      assert.equal(persisted.from.catId, 'kimi');
    } finally {
      f.cleanup();
    }
  }
});
