import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWatcherNativeBridge } from '../dist/watcher-native-bridge.js';

test('native bridge uses the filtered registered MCP tools and preserves exact invocation scope across the transport', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(options?.headers)) });
    return new Response(
      JSON.stringify({ message: { id: 'original-1', content: 'A precise source', threadId: 'line-1' } }),
      { status: 200 },
    );
  };
  const admitted = new Set();
  const bridge = await createWatcherNativeBridge({
    credentials: {
      invocationId: 'watcher-1',
      callbackToken: 'token-1',
      apiUrl: 'http://127.0.0.1:43210',
      catId: 'codex',
      userId: 'owner-1',
      threadId: 'line-1',
    },
    allowedToolNames: ['cat_cafe_get_message'],
    async admit(callId) {
      if (admitted.has(callId)) return 'replayed';
      if (admitted.size >= 6) return 'exhausted';
      admitted.add(callId);
      return 'accepted';
    },
  });
  try {
    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      ['cat_cafe_get_message'],
    );
    for (let index = 0; index < 6; index++)
      await bridge.call('cat_cafe_get_message', { messageId: 'original-1', mode: 'full' }, `call-${index}`);
    await assert.rejects(
      bridge.call('cat_cafe_get_message', { messageId: 'original-1', mode: 'full' }, 'call-7'),
      /六次/,
    );
    const calls = requests.filter((request) => request.url.includes('/api/callbacks/get-message?'));
    assert.equal(calls.length, 6);
    assert.equal(
      requests.some((request) => !request.url.startsWith('http://127.0.0.1:43210/')),
      false,
      JSON.stringify(requests),
    );
    for (const request of calls) {
      assert.ok(request.url.startsWith('http://127.0.0.1:43210/api/callbacks/get-message?'), request.url);
      assert.equal(request.headers['x-invocation-id'], 'watcher-1');
      assert.equal(request.headers['x-callback-token'], 'token-1');
      assert.match(request.headers['x-watcher-tool-call-id'], /^call-/);
    }
  } finally {
    await bridge.close();
    globalThis.fetch = originalFetch;
  }
});

test('invalid and failed native tool calls spend budget before validation', async () => {
  let count = 0;
  const bridge = await createWatcherNativeBridge({
    credentials: { invocationId: 'observer', callbackToken: 'token' },
    allowedToolNames: ['cat_cafe_get_message'],
    async admit() {
      return ++count <= 6 ? 'accepted' : 'exhausted';
    },
  });
  try {
    for (let index = 0; index < 6; index++)
      await assert.rejects(bridge.call('not_allowed', null, `invalid-${index}`), /not allowed/);
    await assert.rejects(bridge.call('cat_cafe_get_message', {}, 'valid-7'), /六次/);
    assert.equal(count, 7);
  } finally {
    await bridge.close();
  }
});
