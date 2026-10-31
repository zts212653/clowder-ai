/**
 * F174 Phase F (AC-F2) — first-party MCP client stops dual-writing creds.
 *
 * Lives in mcp-server because it tests mcp-server's callbackPost/callbackGet
 * directly. Cloud Codex P2 (PR #1388): API tests must not depend on
 * mcp-server/dist (clean-workspace `pnpm --filter @cat-cafe/api test`
 * would module-not-found).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F174 Phase F (AC-F2): callbackPost/Get headers-only auth', () => {
  test('callbackPost body does NOT include invocationId/callbackToken', async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => '{}',
        json: async () => ({}),
      };
    };
    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';
    try {
      const { callbackPost } = await import('../dist/tools/callback-tools.js');
      await callbackPost('/api/callbacks/post-message', { content: 'hello' });
      assert.equal(capturedBody.content, 'hello');
      assert.equal(capturedBody.invocationId, undefined, 'creds must NOT be in body');
      assert.equal(capturedBody.callbackToken, undefined, 'creds must NOT be in body');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('callbackGet query does NOT include invocationId/callbackToken', async () => {
    let capturedUrl;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => '{}',
        json: async () => ({}),
      };
    };
    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';
    try {
      const { callbackGet } = await import('../dist/tools/callback-tools.js');
      await callbackGet('/api/callbacks/list-threads', { limit: '20' });
      assert.ok(capturedUrl.includes('limit=20'));
      assert.ok(!capturedUrl.includes('invocationId='), 'creds must NOT be in query');
      assert.ok(!capturedUrl.includes('callbackToken='), 'creds must NOT be in query');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
