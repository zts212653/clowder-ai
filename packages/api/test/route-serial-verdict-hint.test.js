/**
 * F167 C2 AC-C7 — route-serial integration: verdict-no-pass hint emission.
 *
 * Pure detector behavior is covered in `verdict-detect.test.js`. This suite
 * locks the wire-up between route-serial and the detector: when a cat's
 * output contains a review verdict keyword AND has no line-start @mention
 * AND collected tool names include no hold_ball, route-serial appends a
 * connector message with `source.connector === 'verdict-no-pass-hint'`.
 *
 * Scope: verify side effect on messageStore.append. We don't verify chain
 * routing (there IS no next cat — that's the whole point of the warning).
 *
 * Prompt-first, non-blocking. Emission failures inside try/catch must not
 * break routing; that's covered implicitly by the try/catch in route-serial.
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

/**
 * Mimics a cat that outputs a verdict AND makes a structured MCP routing call
 * (e.g. `cat_cafe_post_message` with `targetCats`). The tool_use event is yielded
 * mid-stream, exactly as providers emit it during real invocations.
 */
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
    // codex stub — needed when the opus output routes the ball to @codex.
    // Emits a terminal reply with no further @mention so the chain ends there.
    const codexService = createCapturingService('codex', 'ack, no further action.');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
    for await (const _ of routeSerial(deps, ['opus'], 'verdict test', 'user1', threadId, {
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
    for await (const _ of routeSerial(deps, ['opus'], 'verdict test', 'user1', threadId, {
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

describe('F167 C2 AC-C7: route-serial verdict-no-pass hint emission', () => {
  test('LGTM with no @mention + no hold_ball → emits verdict-no-pass-hint', async () => {
    const { appended } = await runRoute('LGTM, all tests pass', 'thread-vh-1');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.ok(hint, 'must append a message whose source.connector === verdict-no-pass-hint');
    assert.equal(hint.userId, 'system');
    assert.equal(hint.catId, null);
    assert.match(hint.content, /传球|hold_ball/);
    assert.equal(hint.source.icon, '🏓');
    assert.equal(hint.source.meta.presentation, 'system_notice');
  });

  test('Chinese verdict (修改建议) with no @ + no hold_ball → emits hint', async () => {
    const { appended } = await runRoute('修改建议：重命名 foo → bar', 'thread-vh-2');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.ok(hint, 'Chinese verdict must also trigger the hint');
  });

  test('verdict + line-start @mention → NO hint (ball was passed)', async () => {
    const { appended } = await runRoute('LGTM\n@codex review 一下', 'thread-vh-3');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'line-start @ means ball was routed — hint must not fire');
  });

  test('plain chatter with no verdict keyword → NO hint', async () => {
    const { appended } = await runRoute('let me think about this more', 'thread-vh-4');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'no verdict keyword → hint must not fire');
  });

  test('verdict + cat_cafe_post_message.targetCats → NO hint (structured MCP ball-pass)', async () => {
    const { appended } = await runRouteWithTool('LGTM, review done', 'thread-vh-5', 'cat_cafe_post_message', {
      content: 'review done',
      targetCats: ['codex'],
    });
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'structured post_message.targetCats must exempt the hint');
  });

  test('verdict + cat_cafe_multi_mention.targets → NO hint', async () => {
    const { appended } = await runRouteWithTool('修改建议：拆分这个函数', 'thread-vh-6', 'cat_cafe_multi_mention', {
      targets: ['codex', 'gemini'],
      question: 'review this',
      callbackTo: 'opus',
    });
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'structured multi_mention.targets must exempt the hint');
  });

  test('verdict + post_message WITHOUT targetCats → hint fires (passive post, not routing)', async () => {
    // Calling post_message without targetCats is just posting to the thread — it doesn't
    // route the ball to any specific cat. Hint should still fire.
    const { appended } = await runRouteWithTool('LGTM, check is done', 'thread-vh-7', 'cat_cafe_post_message', {
      content: 'done',
    });
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.ok(hint, 'post_message without targetCats does not constitute routing → hint fires');
  });

  test('provider-prefixed tool name (mcp__cat-cafe__cat_cafe_post_message) + targetCats → NO hint', async () => {
    const { appended } = await runRouteWithTool('LGTM', 'thread-vh-8', 'mcp__cat-cafe__cat_cafe_post_message', {
      targetCats: ['codex'],
    });
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'provider-wrapped tool names must still match structured routing');
  });

  test('long post_message payload with targetCats still suppresses hint', async () => {
    const { appended } = await runRouteWithTool('LGTM, review done', 'thread-vh-9', 'cat_cafe_post_message', {
      content: 'x'.repeat(400),
      targetCats: ['codex'],
    });
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(
      hint,
      undefined,
      'structured routing must be read from raw toolInput, not truncated StoredToolEvent.detail',
    );
  });

  test('verdict + line-start @co-creator → NO hint (砚砚 GPT-5.5 fix 2026-04-25)', async () => {
    // Regression lock: cat ending its review/summary with line-start co-creator
    // mention (legitimate escalation to user) was triggering false-positive
    // verdict-no-pass-hint because parseA2AMentions only returns cat handles. Fix:
    // route-serial now also calls detectUserMention and passes hasCoCreatorLineStartMention.
    //
    // NOTE: test fixture's coCreator config is `{mentionPatterns: ['@co-creator']}` +
    // defaults `['@co-creator', '@铲屎官']`. Production cat-config.json adds
    // ['@co-creator', '@co-creator', '@co-creator']; the same code path covers all configured patterns.
    const { appended } = await runRoute('放行延续到 abc12345。\n\n@co-creator', 'thread-vh-10');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'line-start co-creator mention is a legitimate exit; no hint');
  });

  test('verdict + line-start @铲屎官 (CJK co-creator) → NO hint', async () => {
    const { appended } = await runRoute('LGTM\n\n@铲屎官 已确认', 'thread-vh-11');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(hint, undefined, 'CJK co-creator handle 铲屎官 is also a legitimate exit');
  });

  test('verdict + inline @co-creator (NOT line-start) + no other exit → hint fires (control)', async () => {
    // Negative control: inline (mid-line) co-creator mention doesn't count as
    // line-start exit. Hint should still fire.
    const { appended } = await runRoute('LGTM, ask @co-creator to confirm later please', 'thread-vh-12');
    const hint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.ok(hint, 'inline (mid-line) co-creator mention is not a line-start exit; hint must fire');
  });
});
