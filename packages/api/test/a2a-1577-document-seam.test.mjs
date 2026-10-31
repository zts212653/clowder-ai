import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerCallbackDocumentRoutes } from '../src/routes/callback-document-routes.ts';

// Actual HTTP authentication and MD renderer; scoped Collective authority is
// covered separately, not invented here. All accepted document assets remain.
async function fixture(t) {
  const uploads = await mkdtemp(join(tmpdir(), 'sol-a2a-1577-documents-'));
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploads;
  const registry = new InvocationRegistry();
  const auth = {
    ...(await registry.create('document-owner', 'opus', 'document-thread')),
    threadId: 'document-thread',
    catId: 'opus',
  };
  const app = Fastify();
  const events = [];
  registerCallbackAuthHook(app, registry);
  registerCallbackDocumentRoutes(app, {
    registry,
    socketManager: { broadcastAgentMessage: (event) => events.push(event) },
    invocationTracker: { getLifecycleResponseMessageId: () => 'owned-document-response' },
  });
  t.after(async () => {
    await app.close();
    getRichBlockBuffer().consume(auth.threadId, auth.catId, auth.invocationId);
    if (previous === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previous;
  });
  const post = (headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken }) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/generate-document',
      headers,
      payload: { markdown: '# Owned integration document\n保留正文。', baseName: 'owned', format: 'md' },
    });
  return { uploads, auth, events, post };
}

test('actual MD HTTP publication binds its rich event to the current response and retains bytes', async (t) => {
  const f = await fixture(t);
  const response = await f.post();
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.format, 'md');
  assert.equal(
    await readFile(join(f.uploads, body.url.slice('/uploads/'.length)), 'utf8'),
    '# Owned integration document\n保留正文。',
  );
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].messageId, 'owned-document-response');
  assert.equal(f.events[0].invocationId, f.auth.invocationId);
  assert.equal(getRichBlockBuffer().hasKind(f.auth.threadId, f.auth.catId, f.auth.invocationId, 'file'), true);
});

test('completed document invocation cannot publish a late rich event', async (t) => {
  const f = await fixture(t);
  getRichBlockBuffer().consume(f.auth.threadId, f.auth.catId, f.auth.invocationId);
  const response = await f.post();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'RICH_BLOCK_INVOCATION_COMPLETE');
  assert.equal(f.events.length, 0);
});

test('document HTTP route requires actual invocation credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({})).statusCode, 401);
  assert.equal(f.events.length, 0);
});
