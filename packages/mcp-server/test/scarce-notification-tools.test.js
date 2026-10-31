import assert from 'node:assert/strict';
import { test } from 'node:test';

test('post_message advertises notification-only delivery and forwards the API receipt', async (t) => {
  const { postMessageInputSchema, handlePostMessage } = await import('../dist/tools/callback-tools.js');
  assert.ok(postMessageInputSchema.effectClass, 'same-thread MCP must expose fyi');
  assert.equal(postMessageInputSchema.effectClass.safeParse('fyi').success, true);
  assert.match(postMessageInputSchema.effectClass.description, /without waking/);
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  process.env.CAT_CAFE_INVOCATION_ID = 'notification-invocation';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'notification-token';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.effectClass, 'fyi');
    assert.deepEqual(body.targetCats, ['fable-5']);
    return {
      ok: true,
      json: async () => ({ status: 'ok', deliveredWithoutWake: ['fable-5'], message: '已送达，未叫醒' }),
    };
  });
  const result = await handlePostMessage({ content: 'FYI', targetCats: ['fable-5'], effectClass: 'fyi' });
  assert.match(result.content[0].text, /已送达，未叫醒/);
  assert.equal(result.isError, undefined);
});
