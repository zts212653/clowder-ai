/**
 * F167 Phase H AC-H3/H5 — route-serial integration: routing syntax correction.
 *
 * Pure detector coverage is in `final-routing-slot.test.js`. This suite locks
 * the wire-up between route-serial and the validator:
 *   - Inline @ in final routing slot + no legitimate exit stays internal
 *   - Legitimate exit (line-start @ / hold_ball / MCP targetCats) needs no correction
 *   - Structural exemptions (fenced code, blockquote, URL) need no correction
 *   - AC-H5: protocol correction never appends a public History hint
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

let catRegistryLock = Promise.resolve();

async function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

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

function createToolCallingService(catId, text, toolName, toolInput) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput,
        id: `tool-${Date.now()}`,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendedMessages) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++counter}`,
          userId: msg.userId ?? '',
          catId: msg.catId ?? null,
          content: msg.content ?? '',
          mentions: msg.mentions ?? [],
          timestamp: msg.timestamp ?? 0,
          source: msg.source,
        };
        appendedMessages.push(stored);
        return stored;
      },
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

async function runRoute(text, threadId) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    const appended = [];
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createCapturingService('opus', text);
      const codexService = createCapturingService('codex', 'ack, no further action.');
      const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
      for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        thinkingMode: 'play',
      })) {
      }
      return { appended, opusCalls: opusService.calls };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

async function runRouteWithTool(text, threadId, toolName, toolInput) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    const appended = [];
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const opusService = createToolCallingService('opus', text, toolName, toolInput);
      const codexService = createCapturingService('codex', 'ack, no further action.');
      const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
      for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        thinkingMode: 'play',
      })) {
      }
      return { appended };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

describe('F167 Phase H AC-H3: routing syntax stays an internal correction signal', () => {
  test('exports a dedicated internal correction counter', async () => {
    const { routingSyntaxCorrectionDetected } = await import('../dist/infrastructure/telemetry/instruments.js');
    assert.equal(typeof routingSyntaxCorrectionDetected.add, 'function');
  });

  test('inline @ in final slot + no legitimate exit → no public routing-syntax-hint', async () => {
    const { appended } = await runRoute('我让 @codex 看了下', 'thread-ph-1');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'agent-format correction must not append a public History message');
  });

  test('legitimate line-start @ exit → NO routing-syntax-hint', async () => {
    // Last paragraph has line-start @codex → legitimate route; no hint even
    // though an earlier paragraph has inline @gpt52.
    const { appended } = await runRoute('之前我问过 @gpt52 的意见。\n\n@codex review', 'thread-ph-2');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'line-start @ exit must suppress routing-syntax-hint');
  });

  test('@ only inside fenced code block → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('示例用法：\n\n```\necho "@codex review"\n```', 'thread-ph-3');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'fenced code exempts @; no hint');
  });

  test('@ only inside blockquote → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('> co-creator说：让 @codex 看看', 'thread-ph-4');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'blockquote exempts @; no hint');
  });

  test('plain text with no @ → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('普通回复，没有任何 mention', 'thread-ph-5');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'no @ means no hint');
  });

  test('structured MCP routing (post_message.targetCats) suppresses routing-syntax-hint', async () => {
    const { appended } = await runRouteWithTool('让 @codex 看了下', 'thread-ph-6', 'cat_cafe_post_message', {
      content: 'review needed',
      targetCats: ['codex'],
    });
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'structured routing is a legitimate exit; no hint');
  });
});

describe('F167 Phase H AC-H5: liveness diagnostics stay out of public History', () => {
  test('inline @ + LGTM (verdict) in slot → no public correction hints', async () => {
    const { appended } = await runRoute('LGTM, 我让 @codex 看了下', 'thread-ph-7');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(phaseH, undefined);
    assert.equal(verdictHint, undefined);
  });

  test('verdict LGTM without inline @ → detector does not add a public verdict hint', async () => {
    const { appended } = await runRoute('LGTM, all tests pass', 'thread-ph-8');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(phaseH, undefined, 'Phase H does not fire without inline @ in slot');
    assert.equal(verdictHint, undefined, 'protocol diagnostics must remain internal');
  });
});
