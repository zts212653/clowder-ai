import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

function createMockService(catId, text = 'hello') {
  return {
    async *invoke(_prompt) {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createCapturingService(catId, text = 'hello') {
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

function createSequentialCapturingService(catId, responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      const text = responses[index] ?? responses[responses.length - 1] ?? 'ok';
      index += 1;
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, threadStore = null) {
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
      threadStore,
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

describe('F046 B5 runtime regression scenarios', () => {
  it('debug mode: downstream cat can see upstream response text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '已审查');
    const deps = createMockDeps({
      opus: createMockService('opus', '代码完成\n@缅因猫 请review'),
      codex: codexService,
    });

    for await (const _ of routeSerial(deps, ['opus'], 'write code', 'user1', 'thread1', { thinkingMode: 'debug' })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    assert.ok(codexService.calls[0].includes('代码完成'), 'debug mode should include upstream response text');
  });

  it('play mode: downstream cat cannot see upstream response text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '已审查');
    const deps = createMockDeps({
      opus: createMockService('opus', '代码完成\n@缅因猫 请review'),
      codex: codexService,
    });

    for await (const _ of routeSerial(deps, ['opus'], 'write code', 'user1', 'thread1', { thinkingMode: 'play' })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    assert.ok(!codexService.calls[0].includes('代码完成'), 'play mode should isolate upstream response text');
  });

  it('same-family review chain no longer injects invalid identity marker in debug mode', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const opusService = createCapturingService('opus', '收到，继续处理');
      const deps = createMockDeps({
        codex: createMockService('codex', '代码完成\n@gpt52 请 review'),
        gpt52: createMockService('gpt52', '我看过了，先给结论\n@opus 请继续'),
        opus: opusService,
      });

      for await (const _ of routeSerial(deps, ['codex'], 'debug review chain', 'user1', 'thread1', {
        thinkingMode: 'debug',
      })) {
      }

      assert.equal(opusService.calls.length, 1, 'downstream opus should be called once');
      assert.ok(
        opusService.calls[0].includes('我看过了，先给结论'),
        'downstream prompt should still include upstream review text in debug mode',
      );
      assert.ok(
        !opusService.calls[0].includes('⚠️ Review 无效：同族 reviewer identity check 未通过'),
        'downstream prompt should not contain deprecated identity invalid marker',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('line-start @mention always routes (no keyword gate)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '@缅因猫 收到，我在等'),
      codex: createMockService('codex', '收到'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'status', 'user1', 'thread1', { thinkingMode: 'debug' })) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(handoffs.length, 1, 'line-start mention should trigger handoff (no keyword gate)');
    assert.ok(codexText.length > 0, 'line-start mention should invoke codex');
  });

  it('D1 actionable mention in same paragraph: should route', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '@缅因猫 请 review 这个改动'),
      codex: createMockService('codex', '收到，开始 review'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'review request', 'user1', 'thread1', {
      thinkingMode: 'debug',
    })) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(handoffs.length, 1, 'actionable mention should trigger handoff');
    assert.ok(codexText.length > 0, 'actionable mention should invoke codex');
  });

  it('D1 CJK actionable mention: should route', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '@缅因猫 请确认这个变更'),
      codex: createMockService('codex', '已确认'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'confirm', 'user1', 'thread1', { thinkingMode: 'debug' })) {
      messages.push(msg);
    }

    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.ok(codexText.length > 0, 'CJK actionable mention should invoke codex');
  });

  it('cross-paragraph @mention routes without mode setting (keyword gate removed)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const thread = threadStore.create('user1', 'no keyword gate');
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '@缅因猫\n\n这是交接文档'),
        codex: createMockService('codex', '收到，开始 review'),
      },
      threadStore,
    );

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'review request', 'user1', thread.id, {
      thinkingMode: 'debug',
    })) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(handoffs.length, 1, 'cross-paragraph mention should route (no keyword gate)');
    assert.ok(codexText.length > 0, 'codex should be invoked');
  });

  it('line-start @mention with arbitrary text routes (no keyword matching)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '@缅因猫 prefix issue'),
      codex: createMockService('codex', '收到'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'boundary', 'user1', 'thread1', { thinkingMode: 'debug' })) {
      messages.push(msg);
    }

    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.ok(codexText.length > 0, 'line-start @mention routes regardless of text content');
  });

  it('D2 metadata is handle-free in invocation context', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['opus'],
      mcpAvailable: false,
      directMessageFrom: 'opus',
      activeParticipants: [{ catId: 'opus', lastMessageAt: 1710000000000, messageCount: 3 }],
    });

    assert.match(ctx, /^Direct message from 布偶猫\(opus\)/m);
    assert.match(ctx, /最近活跃：布偶猫\(opus\)/);
    assert.ok(!ctx.includes('Direct message from @opus'), 'metadata should not use @handle');
    assert.ok(!ctx.includes('最近活跃：@opus'), 'activity should not use @handle');
  });

  it('no routing suppression feedback injected (suppression system removed)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const thread = threadStore.create('user1', 'no suppression');
    const opusService = createCapturingService('opus', '收到');
    const codexService = createSequentialCapturingService('codex', ['@布偶猫', '第二次调用']);
    const deps = createMockDeps({ codex: codexService, opus: opusService }, threadStore);

    for await (const _ of routeSerial(deps, ['codex'], 'first', 'user1', thread.id, { thinkingMode: 'debug' })) {
    }
    for await (const _ of routeSerial(deps, ['codex'], 'second', 'user1', thread.id, { thinkingMode: 'debug' })) {
    }

    // Bare @布偶猫 now routes, and no feedback is injected
    assert.ok(
      !codexService.calls[1].includes('Routing feedback(one-shot):'),
      'routing suppression feedback should never appear (system removed)',
    );
  });
});
