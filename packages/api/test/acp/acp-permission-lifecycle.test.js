import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';
import { createAgyAcpPermissionHandler } from '../../dist/domains/cats/services/agents/providers/acp/agy/agy-acp-permission.js';
import { createAcpPermissionHandler } from '../../dist/domains/cats/services/agents/providers/acp/permissions/acp-permission-interaction.js';
import { RuntimeInteractionService } from '../../dist/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../../dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const owner = { userId: 'user-a', threadId: 'thread-a', catId: 'kimi', invocationId: 'inv-a' };
const permission = (sessionId) => ({
  jsonrpc: '2.0',
  id: 'permission',
  method: 'session/request_permission',
  params: {
    sessionId,
    toolCall: { title: 'MCP action', rawInput: {}, _meta: { mcp: { server: 'trusted', tool: 'read' } } },
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Allow for session' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' },
    ],
  },
});
function interactions() {
  const store = new InMemoryRuntimeInteractionStore();
  const service = new RuntimeInteractionService({
    store,
    hostEpoch: 'host-a',
    cardPublisher: {
      prepare: async (request) => ({
        threadId: owner.threadId,
        messageId: request.interactionId,
        blockId: request.interactionId,
      }),
      publish: async () => {},
      isLive: async () => true,
    },
  });
  return { store, service };
}
async function pending(store) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const entry = (await store.listPendingByUser(owner.userId))[0];
    if (entry) return entry;
    await new Promise(setImmediate);
  }
  assert.fail('missing pending confirmation');
}

test('ask user cannot broaden the real AGY guard from allow_once to allow_always', async () => {
  const guard = createAgyAcpPermissionHandler({
    sessionId: 's',
    workspace: process.cwd(),
    profileHome: process.cwd(),
    autoApprove: false,
    readOnly: false,
    mcpServers: ['trusted'],
    isActive: () => true,
  });
  let card;
  let result;
  const handler = createAcpPermissionHandler({
    mode: 'ask_user',
    sessionId: 's',
    owner,
    guard,
    isActive: () => true,
    port: {
      request: async (request) => {
        card = request;
        return { kind: 'decision', decisionId: 'option-1' };
      },
    },
  });
  await handler(permission('s'), (value) => {
    result = value;
  });
  assert.notEqual(result.optionId, 'always');
  assert.deepEqual(
    card.decisions.map((decision) => decision.id),
    ['option-0', 'option-2', 'cancel'],
  );
});

for (const end of ['cancel', 'budget']) {
  test(`HTTP ${end} releases a real pending interaction without a user answer`, async (t) => {
    const { store, service } = interactions();
    const client = new AcpHttpStreamClient({ command: 'unused', args: [], cwd: process.cwd() });
    client.port = 1;
    client.baseUrl = 'http://fixture.invalid/';
    client.sendAgentResponse = async () => {};
    const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
      if (JSON.parse(init.body).method === 'session/cancel') return new Response(null);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(permission('s'))}\n`));
            init.signal.addEventListener('abort', () => controller.error(new Error('fixture transport aborted')), {
              once: true,
            });
          },
        }),
      );
    });
    t.after(() => fetchMock.mock.restore());
    client.setSessionPermissionHandler(
      's',
      createAcpPermissionHandler({ mode: 'ask_user', sessionId: 's', owner, port: service, isActive: () => true }),
    );
    const stream = client.promptStream('s', 'hello', { timeoutMs: end === 'budget' ? 150 : 0, idleStallMs: 0 });
    assert.equal((await stream.next()).value.sessionUpdate, 'permission_pending');
    const next = stream.next().catch((error) => ({ error }));
    const card = await pending(store);
    try {
      if (end === 'cancel') client.cancelSession('s');
      const result = await Promise.race([next, delay(1000, 'still-waiting')]);
      assert.notEqual(result, 'still-waiting', 'transport termination must interrupt permission waiting');
      assert.match(result.error?.name ?? '', end === 'cancel' ? /AcpSessionCancelled/ : /AcpTimeout/);
      assert.equal((await store.get(card.request.interactionId)).status, 'invalidated');
    } finally {
      await service.invalidateInvocation(owner.invocationId, 'provider_cancelled');
      await next;
    }
  });
}

test('replacement session cancels the old confirmation before accepting fresh work', async () => {
  const { store, service: port } = interactions();
  const handlers = new Map();
  const requests = [];
  const replies = [];
  let oldInvalidatedAtReplacement;
  const client = {
    recentCapacitySignal: null,
    newSession: async () => ({ sessionId: 'fresh' }),
    loadSession: async (sessionId) => ({ sessionId }),
    setSessionConfigOption: async () => {},
    setSessionPermissionHandler: (id, handler) => (handler ? handlers.set(id, handler) : handlers.delete(id)),
    cancelSession() {},
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    async *promptStream(sessionId) {
      if (sessionId === 'resumed') {
        requests.push(handlers.get(sessionId)(permission(sessionId), (value) => replies.push(value)));
        await pending(store);
        return 'end_turn';
      }
      for (let attempt = 0; attempt < 50 && (await store.listPendingByUser(owner.userId)).length; attempt++)
        await new Promise(setImmediate);
      oldInvalidatedAtReplacement = (await store.listPendingByUser(owner.userId)).length === 0;
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fresh reply' } },
      };
      return 'end_turn';
    },
  };
  const service = new AcpAgentService({
    catId: owner.catId,
    executionApproval: 'ask_user',
    projectRoot: process.cwd(),
    modelName: 'fixture',
    mcpSupport: false,
    mcpServers: [],
    poolKey: { projectPath: process.cwd(), providerProfile: 'fixture' },
    pool: { acquire: async () => ({ client, release() {} }), rememberSession() {} },
  });
  const messages = await Array.fromAsync(
    service.invoke('hello', { sessionId: 'resumed', auditContext: owner, runtimeInteractionPort: port }),
  );
  await Promise.all(requests);
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
    JSON.stringify(messages),
  );
  assert.equal(oldInvalidatedAtReplacement, true);
  assert.deepEqual(replies, [{ cancelled: true }]);
  const late = [];
  await handlers.get('resumed')(permission('resumed'), (value) => late.push(value));
  assert.deepEqual(late, [{ cancelled: true }]);
});
