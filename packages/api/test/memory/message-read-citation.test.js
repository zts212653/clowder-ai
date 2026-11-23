import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackAuthHook } from '../../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMessageReadRoutes } from '../../dist/routes/callback-message-read-routes.js';
import { fixture } from '../helpers/message-search-answer-fixture.js';

async function readFixture(t) {
  const f = fixture(),
    app = Fastify(),
    registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'codex61-sol', 'origin');
  registerCallbackAuthHook(app, registry);
  registerCallbackMessageReadRoutes(app, { messageStore: f.messages, threadStore: f.threadStore });
  t.after(async () => {
    await app.close();
    f.db.close();
  });
  return {
    ...f,
    async read(id) {
      const r = await app.inject({
        url: `/api/callbacks/get-message?messageId=${id}&mode=full`,
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().message;
    },
  };
}

test('a full original read supplies the revision consumed by the real selected-source publisher', async (t) => {
  const f = await readFixture(t),
    read = await f.read(f.source[1].id);
  assert.match(read.contentRevision ?? '', /^[a-f0-9]{64}$/, 'the read must carry its original citation revision');
  const prepared = await f.service.prepare({
    ...f.request,
    selections: [
      {
        threadId: read.threadId,
        messageId: read.id,
        contentRevision: read.contentRevision,
        quote: read.content,
        reason: 'This is the original statement.',
      },
    ],
  });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.readRefs, [
    { kind: 'message', threadId: read.threadId, messageId: read.id, expectedRevision: read.contentRevision },
  ]);
  assert.equal(prepared.response.results[0].selection.quote, read.content);
  assert.equal(f.searches(), 0);
});

test('full read parts locate repeated text without confusing body and code coordinates', async (t) => {
  const f = await readFixture(t);
  const source = f.messages.append({
    userId: 'owner',
    threadId: 'sources',
    from: { kind: 'user', userId: 'owner' },
    content: 'Repeated phrase',
    contentBlocks: [
      { type: 'text', text: 'Repeated phrase' },
      { type: 'code', language: 'txt', code: 'Repeated phrase' },
    ],
    mentions: [],
    timestamp: 3000,
  });
  const read = await f.read(source.id);
  assert.deepEqual(read.sourceParts, [
    { part: { kind: 'text', blockIndex: 0 }, length: 15 },
    { part: { kind: 'code', blockIndex: 1 }, length: 15 },
  ]);
  const prepared = await f.service.prepare({
    ...f.request,
    selections: [
      {
        threadId: read.threadId,
        messageId: read.id,
        contentRevision: read.contentRevision,
        quote: 'Repeated phrase',
        reason: 'The code block is the selected source.',
        part: read.sourceParts[1].part,
        range: { start: 0, end: 15 },
      },
    ],
  });
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.response.results[0].selection.part, { kind: 'code', blockIndex: 1 });
});
