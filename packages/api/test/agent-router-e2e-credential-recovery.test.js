// #1668 W1 E2E: Failure → @all skip → explicit retry → recovery, warnings in history
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealRouterCatalogFixture } from './helpers/router-catalog-fixture.mjs';

test('@all skip → explicit retry → recovery with store history', async (t) => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
  const { catRegistry } = await import('@cat-cafe/shared');
  const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
  const { AcpProtocolError } = await import('../dist/domains/cats/services/agents/providers/acp/AcpClient.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

  // Use real catalog fixture
  const { projectRoot, configs, revisions } = createRealRouterCatalogFixture();

  // Register cats in catRegistry
  for (const [catId, config] of Object.entries(configs)) {
    if (!catRegistry.has(catId)) {
      catRegistry.register(catId, config);
    }
  }

  // Setup stores
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const testThread = await threadStore.create('test-user', 'E2E Test Thread', projectRoot);
  const threadId = testThread.id;

  // dsh service with credential failure
  const dshClient = {
    promptCapabilities: {}, recentCapacitySignal: null,
    onCapacity() {}, offCapacity() {}, clearRecentCapacitySignal() {},
    async newSession() {
      throw new AcpProtocolError(-32603, 'llm-deepseek: no API key for provider route "deepseek-official"');
    },
  };

  const dshService = new AcpAgentService({
    catId: 'dsh',
    pool: { async acquire() { return { client: dshClient, release() {} }; } },
    poolKey: {},
    projectRoot,
    providerName: 'deepseek-official',
    modelName: 'deepseek-chat',
    mcpSupport: false,
  });

  // opus service with success
  const opusClient = {
    promptCapabilities: {}, recentCapacitySignal: null,
    onCapacity() {}, offCapacity() {}, clearRecentCapacitySignal() {},
    async newSession() { return { sessionId: 'opus-ok' }; },
    async *promptStream() {
      yield { sessionId: 'opus-ok', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }};
    },
  };

  const opusService = new AcpAgentService({
    catId: 'opus',
    pool: { async acquire() { return { client: opusClient, release() {} }; } },
    poolKey: {},
    projectRoot,
    providerName: 'anthropic',
    modelName: 'claude-opus-4',
    mcpSupport: false,
  });

  // Trigger credential_required in dsh
  const dshMessages = [];
  for await (const msg of dshService.invoke('test', { workingDirectory: projectRoot })) {
    dshMessages.push(msg);
  }
  assert.ok(dshMessages.some(m => m.type === 'error' && m.errorCode === 'credential_required'));

  // Setup registry and router
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('dsh', dshService);
  agentRegistry.register('opus', opusService);

  const router = new AgentRouter({
    agentRegistry,
    registry: { register() {}, unregister() {} },
    messageStore,
    threadStore,
    resolveConnectionScope: async (catId) => ({
      memberRevision: revisions[catId],
      cwd: projectRoot,
    }),
  });

  // 1. @all should skip dsh with warning
  const result1 = await router.resolveTargetsAndIntent('@all hello', threadId, { persist: true });
  assert.ok(result1.targetCats.includes('opus'), '@all should include opus');
  assert.ok(!result1.targetCats.includes('dsh'), '@all should skip dsh');
  assert.ok(result1.routing_warnings.some(w => w.kind === 'credential_required' && w.catId === 'dsh'),
    '@all should warn about dsh');

  // Store message with warnings (simulating POST /messages)
  const msg1 = await messageStore.append({
    threadId,
    role: 'user',
    content: '@all hello',
    from: { kind: 'user', userId: 'test-user' },
    targetCats: result1.targetCats,
    createdAt: Date.now(),
    extra: result1.routing_warnings.length > 0 ? { routingWarnings: result1.routing_warnings } : undefined,
  });

  // 2. Explicit @dsh allows retry
  const result2 = await router.resolveTargetsAndIntent('@dsh retry', threadId, { persist: true });
  assert.ok(result2.targetCats.includes('dsh'), 'explicit @dsh should allow retry');
  assert.ok(!result2.routing_warnings.some(w => w.kind === 'credential_required' && w.catId === 'dsh'),
    'explicit @dsh should not warn');

  // 3. Simulate successful dsh execution (would happen via real invoke)
  // In real system, successful invoke updates connectionReadiness
  // For test, we create new service instance with working client
  const dshClientWorking = {
    promptCapabilities: {}, recentCapacitySignal: null,
    onCapacity() {}, offCapacity() {}, clearRecentCapacitySignal() {},
    async newSession() { return { sessionId: 'dsh-ok' }; },
    async *promptStream() {
      yield { sessionId: 'dsh-ok', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'recovered' },
      }};
    },
  };

  const dshServiceRecovered = new AcpAgentService({
    catId: 'dsh',
    pool: { async acquire() { return { client: dshClientWorking, release() {} }; } },
    poolKey: {},
    projectRoot,
    providerName: 'deepseek-official',
    modelName: 'deepseek-chat',
    mcpSupport: false,
  });

  // Replace dsh service in registry
  agentRegistry.register('dsh', dshServiceRecovered);

  // 4. @all after recovery should include dsh
  const result3 = await router.resolveTargetsAndIntent('@all recovered', threadId, { persist: true });
  assert.ok(result3.targetCats.includes('dsh'), '@all should include dsh after recovery');
  assert.ok(result3.targetCats.includes('opus'), '@all should include opus after recovery');
  assert.ok(!result3.routing_warnings.some(w => w.kind === 'credential_required'),
    '@all should not warn after recovery');

  // 5. Verify first message warnings preserved in store
  const history = await messageStore.read({ threadId, limit: 100 });
  const firstMessage = history.messages.find(m => m.content === '@all hello');
  assert.ok(firstMessage, 'First message should be in history');
  assert.ok(firstMessage.extra?.routingWarnings?.length > 0, 'Warnings should be preserved');
  assert.equal(firstMessage.extra.routingWarnings[0].kind, 'credential_required');
  assert.equal(firstMessage.extra.routingWarnings[0].catId, 'dsh');
});
