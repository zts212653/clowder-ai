// #1668 W1: @all skips members with credential_required, explicit mentions allow retry
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealRouterCatalogFixture } from './helpers/router-catalog-fixture.mjs';

test('@all skips credential_required members, explicit mention retries', async (t) => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');
  const { catRegistry } = await import('@cat-cafe/shared');
  const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
  const { AcpProtocolError } = await import('../dist/domains/cats/services/agents/providers/acp/AcpClient.js');
  const { memberConfigurationRevision } = await import('../dist/config/member-config-revision.js');

  // Use real catalog fixture
  const { projectRoot, configs, revisions } = createRealRouterCatalogFixture();

  // Register cats in catRegistry with correct configs
  for (const [catId, config] of Object.entries(configs)) {
    if (!catRegistry.has(catId)) {
      catRegistry.register(catId, config);
    }
  }

  // dsh service with credential_required
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

  // Opus service with ready status
  const opusClient = {
    promptCapabilities: {}, recentCapacitySignal: null,
    onCapacity() {}, offCapacity() {}, clearRecentCapacitySignal() {},
    async newSession() { return { sessionId: 'opus-ok' }; },
    async *promptStream() {
      yield { sessionId: 'opus-ok', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ready' },
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

  // Pre-check: same identity query should return credential_required
  const dshSnapshot = dshService.connectionReadiness({
    memberRevision: revisions.dsh,
    cwd: projectRoot,
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  });
  assert.equal(dshSnapshot.status, 'credential_required', 'Pre-check: dsh should report credential_required');

  // Real AgentRegistry
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('dsh', dshService);
  agentRegistry.register('opus', opusService);

  // Router with updated filterRoutableCatsWithReadiness
  // Router with resolveConnectionScope injected
  const router = new AgentRouter({
    agentRegistry,
    registry: { register() {}, unregister() {} },
    messageStore: { save: async () => {}, getByThread: async () => [] },
    resolveConnectionScope: async (catId, threadId) => ({
      memberRevision: revisions[catId],
      cwd: projectRoot,
    }),
  });

  // Test 1: @all should skip dsh (credential_required)
  const result1 = await router.resolveTargetsAndIntent('@all 大家好', 'test-thread');
  assert.ok(result1.targetCats.includes('opus'), '@all should include opus');
  assert.ok(!result1.targetCats.includes('dsh'), '@all should skip dsh (credential_required)');

  // Test 2: explicit @dsh should allow retry
  const result2 = await router.resolveTargetsAndIntent('@dsh 试试看', 'test-thread');
  assert.ok(result2.targetCats.includes('dsh'), 'explicit @dsh should allow retry');

  // Test 3: @all @dsh should include dsh
  const result3 = await router.resolveTargetsAndIntent('@all @dsh 一起试试', 'test-thread');
  assert.ok(result3.targetCats.includes('dsh'), '@all @dsh should include dsh');
  assert.ok(result3.targetCats.includes('opus'), '@all @dsh should include opus');
});
