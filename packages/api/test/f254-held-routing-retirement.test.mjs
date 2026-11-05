import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { handleCrossPostMessage, handlePostMessage } from '../../mcp-server/src/tools/callback-tools.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { callbacksRoutes } from '../src/routes/callbacks.ts';

test('real API routing mismatch stays unsent through ordinary and cross-thread MCP without a freshness instruction', async (t) => {
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const source = threadStore.create('owner', 'source');
  const target = threadStore.create('owner', 'target');
  const auth = await registry.create('owner', 'opus', source.id);
  const directory = await mkdtemp(join(tmpdir(), 'retired-held-'));
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    invocationQueue: new InvocationQueue(),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  const env = {
    CAT_CAFE_API_URL: 'http://fixture.invalid',
    CAT_CAFE_INVOCATION_ID: auth.invocationId,
    CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
    CAT_CAFE_CREDENTIAL_FILE: undefined,
    CAT_CAFE_CALLBACK_OUTBOX_DIR: directory,
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const replies = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const result = await app.inject({
      method: options.method,
      url: new URL(url).pathname,
      headers: Object.fromEntries(new Headers(options.headers)),
      payload: options.body,
    });
    replies.push(result.json());
    return {
      ok: result.statusCode < 400,
      status: result.statusCode,
      json: async () => result.json(),
      text: async () => result.body,
    };
  });
  for (const send of [handlePostMessage, (input) => handleCrossPostMessage({ ...input, threadId: target.id })]) {
    const result = await send({ content: 'FYI\n@codex', targetCats: ['opus'] });
    const response = replies.at(-1);
    assert.equal(response.status, 'held');
    assert.equal(response.reason, 'routing_mismatch');
    assert.deepEqual(response.unexpectedTargets, ['codex']);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /routing_mismatch.*targetCats/s);
    assert.doesNotMatch(result.content[0].text, /freshness|readIntent|cat_cafe_get_thread_context|acknowledgeHeld/i);
    assert.equal(messageStore.getByThread(source.id).length, 0);
    assert.equal(messageStore.getByThread(target.id).length, 0);
  }
  const corrected = await handlePostMessage({ content: 'FYI\n@codex', targetCats: ['codex'] });
  assert.notEqual(corrected.isError, true);
  assert.equal(
    messageStore.getByThread(source.id).length,
    1,
    'correcting the intended recipients is actionable without a bypass',
  );
  assert.equal(replies.length, 3, 'neither rejection adds an automatic read or resend');
});
