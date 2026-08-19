import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Fastify from 'fastify';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';

const THREAD_ID = 'thread-f264-gap-f-draft-route';
const OWNER_ID = 'owner-f264-gap-f';
const AUTH_HEADERS = { 'x-cat-cafe-user': OWNER_ID };
const apps = [];
const QUOTE_ATTACHMENT_BLOCK = {
  type: 'context_attachment',
  attachment: {
    v: 1,
    id: 'ctx-f264-durable-quote',
    kind: 'quote',
    text: 'selected durable passage',
    comment: 'paired durable comment',
    source: {
      kind: 'message',
      threadId: THREAD_ID,
      messageId: 'message-f264-durable-source',
    },
  },
};

function createApp() {
  const app = Fastify();
  app.register(messageActionsRoutes, {
    messageStore: new MessageStore(),
    socketManager: {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('F264 Gap F owner composer draft API', () => {
  it('fails closed when the true-recall coordination dependencies are unavailable', async () => {
    const app = createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages/message-unavailable/recall',
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(response.json(), {
      error: 'True recall is unavailable',
      code: 'TRUE_RECALL_UNAVAILABLE',
    });
  });

  it('requires strict identity and preserves the revision fence across clear', async () => {
    const app = createApp();
    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
    });
    assert.equal(unauthenticated.statusCode, 401);

    const empty = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
    });
    assert.deepEqual(empty.json(), { draft: null, revision: 0 });

    const put = await app.inject({
      method: 'PUT',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: { expectedRevision: 0, text: '跨 F5 草稿' },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().draft.revision, 1);

    const conflict = await app.inject({
      method: 'PUT',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: { expectedRevision: 0, text: '过期写入' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { code: 'DRAFT_REVISION_MISMATCH', actualRevision: 1 });

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: { expectedRevision: 1 },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { cleared: true, revision: 2 });

    const staleAfterClear = await app.inject({
      method: 'PUT',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: { expectedRevision: 0, text: '旧标签页复活' },
    });
    assert.equal(staleAfterClear.statusCode, 409);
    assert.deepEqual(staleAfterClear.json(), { code: 'DRAFT_REVISION_MISMATCH', actualRevision: 2 });
  });

  it('rejects non-composer blocks and enforces image and attachment limits', async () => {
    const app = createApp();
    for (const contentBlocks of [
      [{ type: 'tool_call', toolName: 'oops', toolId: 'unsafe', input: {} }],
      [{ type: 'image', url: '/uploads/../secret.png' }],
      Array.from({ length: 6 }, (_, index) => ({ type: 'image', url: `/uploads/too-many-${index}.png` })),
      Array.from({ length: 13 }, (_, index) => ({
        ...QUOTE_ATTACHMENT_BLOCK,
        attachment: { ...QUOTE_ATTACHMENT_BLOCK.attachment, id: `ctx-too-many-${index}` },
      })),
    ]) {
      const invalid = await app.inject({
        method: 'PUT',
        url: `/api/threads/${THREAD_ID}/composer-draft`,
        headers: AUTH_HEADERS,
        payload: { expectedRevision: 0, text: '非法附件', contentBlocks },
      });
      assert.equal(invalid.statusCode, 400);
    }

    const valid = await app.inject({
      method: 'PUT',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: {
        expectedRevision: 0,
        text: '合法图片草稿',
        contentBlocks: [{ type: 'image', url: '/uploads/f264-draft.png' }],
      },
    });
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().draft.revision, 1);
  });

  it('round-trips canonical ContextAttachment blocks with text and images', async () => {
    const app = createApp();
    const contentBlocks = [{ type: 'image', url: '/uploads/f264-durable.png' }, QUOTE_ATTACHMENT_BLOCK];
    const put = await app.inject({
      method: 'PUT',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
      payload: {
        expectedRevision: 0,
        text: 'durable text beside attachment',
        contentBlocks,
      },
    });

    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().draft.contentBlocks, contentBlocks);

    const get = await app.inject({
      method: 'GET',
      url: `/api/threads/${THREAD_ID}/composer-draft`,
      headers: AUTH_HEADERS,
    });
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(get.json().draft.text, 'durable text beside attachment');
    assert.deepEqual(get.json().draft.contentBlocks, contentBlocks);
  });
});
