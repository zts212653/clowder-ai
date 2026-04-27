/**
 * F167 Phase H AC-H3/H5 — route-serial integration: routing-syntax-hint emission.
 *
 * Pure detector coverage is in `final-routing-slot.test.js`. This suite locks
 * the wire-up between route-serial and the validator:
 *   - Inline @ in final routing slot + no legitimate exit → appends
 *     `source.connector === 'routing-syntax-hint'` system message
 *   - Legitimate exit (line-start @ / hold_ball / MCP targetCats) → no emit
 *   - Structural exemptions (fenced code, blockquote, URL) → no emit
 *   - AC-H5: when Phase H hits AND verdict-no-pass would also hit, only
 *     routing-syntax-hint emits (root-cause wins; AC-C7 suppressed)
 */

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
  const original = catRegistry.getAllConfigs();
  await loadRealRoster();
  const appended = [];
  try {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createCapturingService('opus', text);
    const codexService = createCapturingService('codex', 'ack, no further action.');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
    for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
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
}

async function runRouteWithTool(text, threadId, toolName, toolInput) {
  const original = catRegistry.getAllConfigs();
  await loadRealRoster();
  const appended = [];
  try {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createToolCallingService('opus', text, toolName, toolInput);
    const codexService = createCapturingService('codex', 'ack, no further action.');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
    for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
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
}

describe('F167 Phase H AC-H3: route-serial routing-syntax-hint emission', () => {
  test('inline @ in final slot + no legitimate exit → emits routing-syntax-hint', async () => {
    const { appended } = await runRoute('我让 @codex 看了下', 'thread-ph-1');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.ok(hint, 'must append routing-syntax-hint when slot has inline @ with no exit');
    assert.equal(hint.userId, 'system');
    assert.equal(hint.catId, null);
    assert.match(hint.content, /@codex/);
    assert.match(hint.content, /行中|行首/);
    assert.equal(hint.source.icon, '⚠️');
    assert.equal(hint.source.meta.presentation, 'system_notice');
    assert.equal(hint.source.meta.noticeTone, 'warning');
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
    const { appended } = await runRoute('> 铲屎官说：让 @codex 看看', 'thread-ph-4');
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

describe('F167 Phase H AC-H5: AC-C7 verdict-no-pass suppression when Phase H hits', () => {
  test('inline @ + LGTM (verdict) in slot → only routing-syntax-hint, NOT verdict-no-pass-hint', async () => {
    const { appended } = await runRoute('LGTM, 我让 @codex 看了下', 'thread-ph-7');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.ok(phaseH, 'Phase H hint must emit (root cause)');
    assert.equal(verdictHint, undefined, 'AC-H5: verdict-no-pass-hint must be suppressed when Phase H hits');
  });

  test('verdict LGTM without inline @ → verdict-no-pass-hint still emits (Phase H not hit)', async () => {
    // Control case: Phase H does NOT fire (no inline @ in slot). AC-C7 should still fire.
    const { appended } = await runRoute('LGTM, all tests pass', 'thread-ph-8');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(phaseH, undefined, 'Phase H does not fire without inline @ in slot');
    assert.ok(verdictHint, 'AC-C7 still fires on verdict-only output when Phase H did not hit');
  });
});
