/**
 * F174 Phase E AC-E2/E5 — write-class tools wrapped by withDegradation.
 *
 * Each tool declares an explicit degradePolicy (kind:'none' for tools
 * without a meaningful fallback today). Wrapping is observable via
 * surfacing the structured failure reason on degradable 401s.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function withMockedCallbackPost(fn) {
  const callbackToolsMod = await import('../dist/tools/callback-tools.js');
  // The handlers all live in callback-tools.js and call callbackPost internally.
  // We mock fetch to control what callbackPost sees.
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = async () => {
    fetchCallCount++;
    return {
      ok: false,
      status: 401,
      headers: new Map(),
      text: async () => JSON.stringify({ error: 'callback_auth_failed', reason: 'expired' }),
    };
  };
  process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
  process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';
  try {
    return await fn(callbackToolsMod, () => fetchCallCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('write-class tool degradation policy declarations (F174-E AC-E2/E5)', () => {
  test('post_message with kind:none surfaces structured failure (no degrade)', async () => {
    await withMockedCallbackPost(async ({ handlePostMessage }) => {
      const result = await handlePostMessage({ content: 'test message' });
      assert.ok(result.isError, 'auth failure must propagate');
      const text = result.content[0].text;
      assert.ok(
        text.includes('[degrade]') && text.includes('reason=expired'),
        `expected [degrade] hint with reason: ${text}`,
      );
    });
  });

  test('update_task with kind:none surfaces failure', async () => {
    await withMockedCallbackPost(async ({ handleUpdateTask }) => {
      const result = await handleUpdateTask({ taskId: 't-1', status: 'done' });
      assert.ok(result.isError);
      const text = result.content[0].text;
      assert.ok(text.includes('[degrade]') && text.includes('reason=expired'));
    });
  });

  test('register_pr_tracking with kind:none surfaces failure', async () => {
    await withMockedCallbackPost(async ({ handleRegisterPrTracking }) => {
      const result = await handleRegisterPrTracking({ repoFullName: 'a/b', prNumber: 1 });
      assert.ok(result.isError);
      const text = result.content[0].text;
      assert.ok(text.includes('[degrade]') && text.includes('reason=expired'));
    });
  });

  test('retain_memory_callback with kind:none surfaces failure', async () => {
    const memMod = await import('../dist/tools/callback-memory-tools.js');
    await withMockedCallbackPost(async () => {
      const result = await memMod.handleCallbackRetainMemory({ content: 'remember this' });
      assert.ok(result.isError);
      const text = result.content[0].text;
      assert.ok(text.includes('[degrade]') && text.includes('reason=expired'));
    });
  });

  // Cloud Codex P2 (PR #1384, 01:59Z): the legacy 403/not-configured branch
  // in handleCreateRichBlock returns Route B from `primary`, so the framework
  // treats it as primary success and skips DEGRADED:true tagging. Both
  // fallback paths (legacy 403 + framework custom degrade on auth) must mark
  // `DEGRADED:true` so dashboards/cats classify fallback mode consistently.
  test('AC-E4 consistency: legacy 403 fallback also marks DEGRADED:true', async () => {
    const callbackToolsMod = await import('../dist/tools/callback-tools.js');
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      // First call = create-rich-block POST → 403 not configured
      if (callCount === 1) {
        return {
          ok: false,
          status: 403,
          headers: new Map(),
          text: async () => 'create_rich_block requires not configured: callback service',
        };
      }
      // Second call = post-message (Route B) → 200 OK
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({ ok: true, messageId: 'msg-1' }),
        json: async () => ({ ok: true, messageId: 'msg-1' }),
      };
    };
    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';
    try {
      const result = await callbackToolsMod.handleCreateRichBlock({
        block: JSON.stringify({ id: 'rb-1', kind: 'text', v: 1, content: 'hello' }),
      });
      assert.ok(!result.isError, 'legacy 403 path should succeed via Route B');
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.DEGRADED, true, 'legacy 403 fallback must mark DEGRADED:true');
      assert.equal(parsed.route, 'B_fallback');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
