import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

function createCapturingService(catId, text) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({
        id: `msg-${counter}`,
        userId: '',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

describe('F167 L3: route-serial role-gate integration', () => {
  test('designer (@gemini) + coding task → rejected, downstream cat NOT invoked, system_info emitted', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const geminiService = createCapturingService('gemini', '不应该被调用');
      const deps = createMockDeps({
        opus: createCapturingService('opus', '这里有个 bug\n@gemini fix 这个 bug'),
        gemini: geminiService,
      });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'write code', 'user1', 'thread-rg1', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      assert.strictEqual(geminiService.calls.length, 0, 'designer cat must NOT be invoked for a coding handoff');

      const rejected = events.find(
        (e) => e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_role_rejected'),
      );
      assert.ok(rejected, 'must emit a2a_role_rejected system_info');
      assert.match(rejected.content, /gemini/, 'rejection payload names the target');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('designer (@gemini) + review task → allowed (no coding keyword)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const geminiService = createCapturingService('gemini', '看过了，设计 OK');
      const deps = createMockDeps({
        opus: createCapturingService('opus', '方案初稿\n@gemini review 一下配色'),
        gemini: geminiService,
      });

      for await (const _ of routeSerial(deps, ['opus'], 'design review', 'user1', 'thread-rg2', {
        thinkingMode: 'play',
      })) {
      }

      assert.strictEqual(
        geminiService.calls.length,
        1,
        'designer cat should be invoked for a review handoff (not coding)',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('coder (@codex) + coding task → allowed (non-designer)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const codexService = createCapturingService('codex', '修好了');
      const deps = createMockDeps({
        opus: createCapturingService('opus', '有 bug\n@codex 去 fix 一下'),
        codex: codexService,
      });

      for await (const _ of routeSerial(deps, ['opus'], 'fix bug', 'user1', 'thread-rg3', {
        thinkingMode: 'play',
      })) {
      }

      assert.strictEqual(codexService.calls.length, 1, 'non-designer cat should be invoked for coding handoff');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('designer already pending as original target → NO rejection event (dedup wins over role-gate)', async () => {
    // Codex P1-1 regression: when targetCats=['opus','gemini'] and opus says "@gemini fix bug",
    // gemini is ALREADY pending as an original target. Emitting a2a_role_rejected is contradictory
    // because gemini will still execute (as an original target). Dedup must fire before role-gate.
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const geminiService = createCapturingService('gemini', '收到');
      const deps = createMockDeps({
        opus: createCapturingService('opus', '有 bug\n@gemini fix 这个 bug'),
        gemini: geminiService,
      });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus', 'gemini'], 'fix bug', 'user1', 'thread-rg4', {
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      const rejected = events.filter(
        (e) => e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_role_rejected'),
      );
      assert.strictEqual(
        rejected.length,
        0,
        'must NOT emit a2a_role_rejected when target is already pending as original target',
      );
      assert.strictEqual(geminiService.calls.length, 1, 'gemini must still run as the original user-selected target');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});
