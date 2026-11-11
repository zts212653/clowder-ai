import assert from 'node:assert/strict';
import test from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';

function createNoopService(catId) {
  return {
    invoke: async function* () {
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createNoopRegistry() {
  return {
    create: () => ({ invocationId: 'inv-1', callbackToken: 'cb-1' }),
    update: () => {},
    get: () => null,
  };
}

function createNoopMessageStore() {
  return {
    append: () => ({}),
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThreadBefore: () => [],
    getByThreadAfter: () => [],
    getById: () => null,
    softDelete: () => null,
    restore: () => null,
  };
}

test('user routing resolves a registered ID even when only a nickname was configured', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const original = catRegistry.getAllConfigs();
  catRegistry.reset();
  try {
    for (const [id, config] of Object.entries(original)) {
      catRegistry.register(id, id === 'codex' ? { ...config, mentionPatterns: ['@砚砚'] } : config);
    }
    const router = new AgentRouter(
      await migrateRouterOpts({
        claudeService: createNoopService('opus'),
        codexService: createNoopService('codex'),
        registry: createNoopRegistry(),
        messageStore: createNoopMessageStore(),
      }),
    );
    const result = await router.resolveTargetsAndIntent('请 @CODEX 看一下', 'thread-text');
    assert.equal(result.hasMentions, true);
    assert.deepEqual(result.targetCats, ['codex']);
    for (const message of ['@opus/@CODEX 帮我看看', '@opus\\@CODEX 帮我看看']) {
      const grouped = await router.resolveTargetsAndIntent(message, 'thread-text');
      assert.equal(grouped.hasMentions, true);
      assert.deepEqual(grouped.targetCats, ['opus', 'codex']);
    }
    for (const message of ['@CODEX/docs 已更新', '@types/node 已验证', 'example.com/@codex']) {
      const path = await router.resolveTargetsAndIntent(message, 'thread-text');
      assert.equal(path.hasMentions, false);
      assert.deepEqual(path.routing_warnings, []);
    }
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
  }
});

test('resolveTargetsAndIntent supports speech-style "at + nickname" mentions', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('at咱的砚砚 和 at 宪宪 你们出来了', 'thread-voice');
  assert.deepEqual(result.targetCats, ['codex', 'opus']);
});

test('resolveTargetsAndIntent supports at without spaces', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('at缅因 你先看下这个', 'thread-voice');
  assert.deepEqual(result.targetCats, ['codex']);
});

test('resolveTargetsAndIntent does not activate speech-style aliases in ordinary prose', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('please look at codex docs before changing this', 'thread-voice');
  assert.equal(result.hasMentions, false);
  assert.deepEqual(result.targetCats, ['opus']);
  assert.deepEqual(result.routing_warnings, []);
});

test('resolveTargetsAndIntent supports 艾特 prefix', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('艾特宪宪 看一下这个', 'thread-voice');
  assert.deepEqual(result.targetCats, ['opus']);
});

test('resolveTargetsAndIntent does not false-positive normal words like attack', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('这个 attack 测试先别动', 'thread-voice');
  assert.deepEqual(result.targetCats, ['opus']);
});

test('resolveTargetsAndIntent keeps existing @mentions unchanged', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('@砚砚 看下这个', 'thread-voice');
  assert.deepEqual(result.targetCats, ['codex']);
});

test('resolveTargetsAndIntent supports @。 speech punctuation prefix', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const router = new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );

  const result = await router.resolveTargetsAndIntent('@。砚砚 出来一下', 'thread-voice');
  assert.deepEqual(result.targetCats, ['codex']);
});
