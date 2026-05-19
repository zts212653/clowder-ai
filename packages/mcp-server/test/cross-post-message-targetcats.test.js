/**
 * F193 Phase A — AC-A1: cross_post_message schema accepts targetCats
 *
 * KD-1 reconcile (F193): cross_post_message must expose targetCats so callers
 * can route the cross-thread notification to specific cat(s) WITHOUT relying
 * solely on line-start @mention text parsing. Previously the cross-thread skill
 * doc told cats to pass `targetCats` but the schema never accepted it
 * (callback-tools.ts:355-366) — schema-skill drift.
 *
 * After this AC, both routing credentials work:
 *   1. targetCats: ["catHandle"]  (structured)
 *   2. line-start @catHandle in content (textual)
 *
 * Server-side fail-closed when both are missing is covered by AC-A4
 * (separate test in packages/api).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('F193 AC-A1: cross_post_message schema exposes targetCats', () => {
  test('schema includes targetCats as optional array of strings', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const crossTool = server._registeredTools.cat_cafe_cross_post_message;
    assert.ok(crossTool, 'cross_post_message tool must exist');

    const shapeKeys = Object.keys(crossTool.inputSchema.shape);
    assert.ok(shapeKeys.includes('targetCats'), 'cross_post_message must expose targetCats field (F193 AC-A1)');

    const targetCatsField = crossTool.inputSchema._def.shape().targetCats;
    assert.ok(
      targetCatsField.isOptional(),
      'targetCats must be optional (line-start @ is the alternative routing credential)',
    );
  });

  test('schema description on targetCats explains routing role + agent-key boundary', async () => {
    const { createServer } = await import('../dist/index.js');
    const server = createServer();
    const crossTool = server._registeredTools.cat_cafe_cross_post_message;
    const targetCatsField = crossTool.inputSchema._def.shape().targetCats;
    const description = targetCatsField._def.innerType?._def.description ?? targetCatsField._def.description;
    assert.ok(description, 'targetCats must have a description for agent discoverability');
    assert.ok(
      description.toLowerCase().includes('targetcats') ||
        description.toLowerCase().includes('routing') ||
        description.toLowerCase().includes('cat'),
      'description should explain routing role',
    );
  });

  test('handler forwards targetCats to /api/callbacks/post-message body', async () => {
    // White-box: handleCrossPostMessage source must reference targetCats
    // forwarding. Function.prototype.toString() works regardless of cwd
    // (avoids fragile path resolution under pnpm filter test runs).
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const source = handleCrossPostMessage.toString();
    assert.ok(
      source.includes('targetCats'),
      'handleCrossPostMessage must reference targetCats in its forwarded payload',
    );
  });
});

describe('F193 AC-A4 P1 (codex review): cross_post_message fails closed at MCP layer', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('reject when no targetCats AND no line-start @ — no HTTP dispatch', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'no routing creds at all',
    });
    assert.equal(result.isError, true, 'must reject when no routing creds');
    const text = result.content[0].text;
    assert.ok(text.includes('routing'), `error must mention routing, got: ${text}`);
    assert.equal(
      fetchCalled,
      false,
      'MCP fail-closed must reject EARLY — no HTTP dispatch (closes API-layer gap for agent-key callers)',
    );
  });

  test('reject when agent-key caller cross-posts without routing creds (closes API-layer gap)', async () => {
    // Closing 砚砚 review P1: API route layer only triggers AC-A4 reject
    // when isCrossThread=true (effectiveThreadId !== actor.threadId). For
    // agent-key callers, this branch never fires (target-thread write, no
    // source thread). Without MCP-layer fail-closed, agent-key cross_post
    // missing routing creds would silently land in target thread without
    // triggering any cat session.
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    process.env.CAT_CAFE_AGENT_KEY_FILE = '/dev/null'; // placeholder; we expect fail-closed before any auth resolution

    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'agent-key cross-post with no routing',
      agentKeyCatId: 'antigravity',
    });
    assert.equal(result.isError, true, 'agent-key cross_post without routing must reject at MCP layer');
    assert.equal(fetchCalled, false, 'no HTTP dispatch — MCP layer closes the gap that API layer cannot');
  });

  test('accept when targetCats provided', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'with explicit targets',
      targetCats: ['codex'],
    });
    // If isError, it must NOT be the routing-creds error
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('requires routing credentials'),
        `targetCats present should pass routing gate, got: ${text}`,
      );
    }
  });

  test('accept when content has line-start @', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: '@codex hi from another thread',
    });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('requires routing credentials'),
        `line-start @ present should pass routing gate, got: ${text}`,
      );
    }
  });

  // P1 round 2 (codex review): MCP fail-closed must mirror server parser
  // (a2a-mentions.ts:107-113). Naive `^@\w/m` would reject these legit forms.

  test('accept markdown bullet `- @codex` line-start mention (codex P1 round 2)', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'task list:\n- @codex please review',
    });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('requires routing credentials'),
        `markdown bullet @ should pass (server parser strips prefix), got: ${text}`,
      );
    }
  });

  test('accept markdown blockquote `> @codex` line-start mention (codex P1 round 2)', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'quoted note:\n> @codex see above',
    });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(!text.includes('requires routing credentials'), `markdown blockquote @ should pass, got: ${text}`);
    }
  });

  test('accept Chinese / non-ASCII handle `@缅因猫` (codex P1 round 2)', async () => {
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: '@缅因猫 你好',
    });
    if (result.isError) {
      const text = result.content[0].text;
      assert.ok(
        !text.includes('requires routing credentials'),
        `non-ASCII @handle should pass (server parser supports it), got: ${text}`,
      );
    }
  });

  test('reject @ in fenced code block (server parser strips code fences too)', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ status: 'ok' }) };
    };
    const { handleCrossPostMessage } = await import('../dist/tools/callback-tools.js');
    const result = await handleCrossPostMessage({
      threadId: 'thread-target',
      content: 'see code:\n```\n@codex this is in a code block\n```\nno real mention',
    });
    assert.equal(result.isError, true, '@ inside fenced code block must NOT pass routing gate');
    assert.equal(fetchCalled, false, 'no HTTP dispatch when only routing creds are inside code fences');
  });
});
