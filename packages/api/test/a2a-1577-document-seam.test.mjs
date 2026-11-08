import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerCallbackDocumentRoutes } from '../src/routes/callback-document-routes.ts';

// Actual HTTP authentication and MD renderer; scoped Collective authority is
// covered separately, not invented here. All accepted document assets remain.
async function fixture(t, { withTracker = true } = {}) {
  const uploads = await mkdtemp(join(tmpdir(), 'sol-a2a-1577-documents-'));
  const previous = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploads;
  const registry = new InvocationRegistry();
  const auth = {
    ...(await registry.create('document-owner', 'opus', 'document-thread')),
    threadId: 'document-thread',
    catId: 'opus',
  };
  const tracker = new InvocationTracker();
  const bindResponse = (invocationId, responseMessageId) => {
    tracker.startAll(auth.threadId, [auth.catId], 'document-owner', invocationId);
    assert.equal(
      tracker.bindLifecycleActiveRun(
        {
          threadId: auth.threadId,
          targetId: auth.catId,
          invocationId,
          responseMessageId,
          inputEntryIds: [],
          inputMessageIds: [],
          privateInputEntryIds: [],
          startedAt: Date.now(),
        },
        invocationId,
      ),
      true,
    );
  };
  bindResponse(auth.invocationId, 'owned-document-response');
  const app = Fastify();
  const events = [];
  registerCallbackAuthHook(app, registry);
  registerCallbackDocumentRoutes(app, {
    registry,
    socketManager: { broadcastAgentMessage: (event) => events.push(event) },
    ...(withTracker ? { invocationTracker: tracker } : {}),
  });
  t.after(async () => {
    await app.close();
    await getRichBlockBuffer().consume(auth.threadId, auth.catId, auth.invocationId);
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
  return { uploads, auth, registry, bindResponse, events, post };
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
  await getRichBlockBuffer().consume(f.auth.threadId, f.auth.catId, f.auth.invocationId);
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

test('document publication without a lifecycle tracker keeps its invocation and omits a response identity', async (t) => {
  const f = await fixture(t, { withTracker: false });
  const response = await f.post();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].invocationId, f.auth.invocationId);
  assert.equal(Object.hasOwn(f.events[0], 'messageId'), false);
});

test('an old document callback cannot borrow the successor response or publish into its buffer', async (t) => {
  const f = await fixture(t);
  f.bindResponse('successor-turn', 'successor-response');
  const oldResponse = await f.post();
  assert.equal(oldResponse.statusCode, 200, oldResponse.body);
  assert.equal(f.events[0].invocationId, f.auth.invocationId);
  assert.equal(Object.hasOwn(f.events[0], 'messageId'), false);
  assert.equal((await getRichBlockBuffer().consume(f.auth.threadId, f.auth.catId, f.auth.invocationId)).length, 1);

  const successor = await f.registry.create('document-owner', f.auth.catId, f.auth.threadId);
  f.bindResponse(successor.invocationId, 'successor-response');
  const response = await f.post({
    'x-invocation-id': successor.invocationId,
    'x-callback-token': successor.callbackToken,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.events[1].messageId, 'successor-response');
  assert.equal(f.events[1].invocationId, successor.invocationId);
  const blocks = await getRichBlockBuffer().consume(f.auth.threadId, f.auth.catId, successor.invocationId);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].url, response.json().url);
  assert.notEqual(blocks[0].url, oldResponse.json().url);

  const stale = await f.post();
  assert.equal(stale.statusCode, 401);
  assert.equal(stale.json().error, 'callback_auth_failed');
  assert.equal(stale.json().reason, 'replaced');
  assert.equal(f.events.length, 2);
});
