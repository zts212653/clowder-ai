/**
 * Session Chain Tools — Header Forwarding Tests (P2 contract)
 *
 * Verifies that MCP session-chain tools correctly forward:
 * - x-invocation-id + x-callback-token (invocation credentials)
 * - x-agent-key-secret (persistent MCP auth)
 * - x-cat-id (cat identity)
 * - x-cat-cafe-user (user identity)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

describe('session-chain-tools: header forwarding', () => {
  let originalEnv;
  let capturedHeaders;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    capturedHeaders = null;

    // Mock global fetch to capture headers
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url, opts) => {
      capturedHeaders = opts?.headers ?? {};
      // Return a minimal successful response
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: [], nextCursor: null, total: 0 }),
        text: async () => '{}',
      };
    });
  });

  afterEach(() => {
    // Restore environment
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  async function loadModule() {
    // Dynamic import to pick up current env vars
    // Use cache-busting query to force re-evaluation
    const mod = await import(`../dist/tools/session-chain-tools.js?t=${Date.now()}`);
    return mod;
  }

  it('forwards x-invocation-id and x-callback-token when env vars set', async () => {
    process.env.CAT_CAFE_USER_ID = 'test-user';
    process.env.CAT_CAFE_CAT_ID = 'test-cat';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-123';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'tok-abc';

    const { handleReadSessionEvents } = await loadModule();
    await handleReadSessionEvents({ sessionId: 'sess-1' });

    assert.ok(capturedHeaders, 'fetch should have been called');
    assert.equal(capturedHeaders['x-cat-cafe-user'], 'test-user');
    assert.equal(capturedHeaders['x-cat-id'], 'test-cat');
    assert.equal(capturedHeaders['x-invocation-id'], 'inv-123');
    assert.equal(capturedHeaders['x-callback-token'], 'tok-abc');
  });

  it('forwards x-agent-key-secret when env var set', async () => {
    process.env.CAT_CAFE_USER_ID = 'test-user';
    process.env.CAT_CAFE_AGENT_KEY_SECRET = 'ak-secret-xyz';

    const { handleReadSessionEvents } = await loadModule();
    await handleReadSessionEvents({ sessionId: 'sess-1' });

    assert.ok(capturedHeaders, 'fetch should have been called');
    assert.equal(capturedHeaders['x-agent-key-secret'], 'ak-secret-xyz');
  });

  it('does NOT include invocation headers when env vars absent', async () => {
    process.env.CAT_CAFE_USER_ID = 'test-user';
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_CAT_ID;

    const { handleReadSessionEvents } = await loadModule();
    await handleReadSessionEvents({ sessionId: 'sess-1' });

    assert.ok(capturedHeaders, 'fetch should have been called');
    assert.equal(capturedHeaders['x-cat-cafe-user'], 'test-user');
    assert.equal(capturedHeaders['x-invocation-id'], undefined);
    assert.equal(capturedHeaders['x-callback-token'], undefined);
    assert.equal(capturedHeaders['x-agent-key-secret'], undefined);
    assert.equal(capturedHeaders['x-cat-id'], undefined);
  });

  it('requires BOTH invocation-id and callback-token (partial = no forward)', async () => {
    process.env.CAT_CAFE_USER_ID = 'test-user';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-only';
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;

    const { handleReadSessionEvents } = await loadModule();
    await handleReadSessionEvents({ sessionId: 'sess-1' });

    assert.ok(capturedHeaders);
    // Only invocation-id without token → neither should be forwarded
    assert.equal(capturedHeaders['x-invocation-id'], undefined);
    assert.equal(capturedHeaders['x-callback-token'], undefined);
  });
});
