import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

const OWNER = 'native-send-owner';
const THREAD = 'native-send-thread';
const TEXT = '正文与中文说明';
const QUOTE = {
  v: 1,
  id: 'native-send-quote',
  kind: 'quote',
  text: 'bookShelf',
  comment: '中文绿灯\n原引用仍在',
  source: { kind: 'workspace_file', path: 'docs/a.md', revision: `sha256:${'a'.repeat(64)}` },
};
const BLOCKS = [{ type: 'context_attachment', attachment: QUOTE }];
const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture({ reject = false, beforeAppend, strict = true, queue = false } = {}) {
  const app = Fastify();
  apps.push(app);
  if (strict) {
    app.decorateRequest('sessionUserId', null);
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = OWNER;
    });
  }
  const store = new MessageStore();
  store.putOwnerComposerDraft(OWNER, THREAD, {
    expectedRevision: 0,
    text: TEXT,
    contentBlocks: BLOCKS,
    updatedAt: Date.now(),
  });
  if (beforeAppend) {
    const append = store.appendWithQueueLedgerAdmission.bind(store);
    store.appendWithQueueLedgerAdmission = (...args) => {
      beforeAppend(store);
      return append(...args);
    };
  }
  const dispatches = [];
  const invocationQueue = new InvocationQueue(undefined, { resolveTargets: async () => (reject ? [] : ['opus']) });
  const controller = () => new AbortController();
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    queueProcessor: {
      requestDrain: async () => {},
      tryAutoAppendExactEntry: async () => ({ outcome: 'rejected', reason: 'append_unavailable' }),
    },
    messageStore: store,
    invocationRecordStore: new InvocationRecordStore(),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      resolveTargetsAndIntent: async () => ({ targetCats: reject ? [] : ['opus'], intent: { intent: 'execute' } }),
      routeExecution: async function* (...args) {
        dispatches.push(args);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    },
    invocationTracker: {
      has: () => queue,
      isDeleting: () => false,
      tryStartThread: controller,
      tryStartThreadAll: controller,
      start: controller,
      startAll: controller,
      complete() {},
      completeAll() {},
    },
    threadStore: {
      get: async () => ({ id: THREAD, title: 'Native send', createdBy: OWNER }),
      updateTitle: async () => {},
    },
    ...(invocationQueue ? { invocationQueue } : {}),
  });
  await app.ready();
  return {
    app,
    store,
    dispatches,
    invocationQueue,
    send: (payload) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        payload: {
          content: TEXT,
          threadId: THREAD,
          contextAttachments: [QUOTE],
          composerDraftRevision: 1,
          ...payload,
        },
      }),
  };
}

test('a stored accepted message consumes its matching owner draft before HTTP202, with the revision receipt', async () => {
  const { send, store } = await fixture();
  const response = await send({});
  assert.equal(response.statusCode, 202, response.body);
  assert.ok(response.json().userMessageId);
  assert.equal(store.getOwnerComposerDraft(OWNER, THREAD).text, '');
  assert.deepEqual(response.json().composerDraftConsumption, { threadId: THREAD, expectedRevision: 1, revision: 2 });
});

test('a rejected send leaves its owner draft untouched', async () => {
  const { send, store } = await fixture({ reject: true });
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  assert.equal((await send({ content: '', contextAttachments: [] })).statusCode, 400);
  assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
});

test('a concurrent revision wins even when its text and attachments are identical to the accepted send', async () => {
  const { send, store } = await fixture({
    beforeAppend: (current) => {
      current.putOwnerComposerDraft(OWNER, THREAD, {
        expectedRevision: 1,
        text: TEXT,
        contentBlocks: BLOCKS,
        updatedAt: Date.now(),
      });
    },
  });
  const response = await send({});
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(store.getOwnerComposerDraft(OWNER, THREAD).revision, 2);
  assert.equal(store.getOwnerComposerDraft(OWNER, THREAD).text, TEXT);
  assert.equal(response.json().composerDraftConsumption, undefined);
});

test('a sender without the mounted revision cannot consume the saved draft', async () => {
  const { send, store } = await fixture();
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  assert.equal((await send({ content: '另一条消息', composerDraftRevision: undefined })).statusCode, 202);
  assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
});

test('body identity hints cannot consume another owner draft', async () => {
  const { send, store } = await fixture();
  store.putOwnerComposerDraft('other-owner', THREAD, {
    expectedRevision: 0,
    text: TEXT,
    contentBlocks: BLOCKS,
    updatedAt: Date.now(),
  });
  const before = store.getOwnerComposerDraft('other-owner', THREAD);
  const response = await send({ userId: 'other-owner' });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(store.getOwnerComposerDraft('other-owner', THREAD), before);
});

test('compatibility-only identity cannot consume a durable owner draft', async () => {
  const { send, store } = await fixture({ strict: false });
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  assert.equal((await send({ userId: OWNER })).statusCode, 202);
  assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
});

test('the explicit mounted revision consumes an older saved body when the accepted send contains unsaved edits', async () => {
  const { send, store } = await fixture();
  const response = await send({ content: '刚打的新正文\n无需等待防抖' });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(store.getOwnerComposerDraft(OWNER, THREAD).text, '');
  assert.equal(store.getById(response.json().userMessageId).content, '刚打的新正文\n无需等待防抖');
});

test('a stored queue admission consumes the bound draft before its accepted response', async () => {
  const { send, store } = await fixture({ queue: true });
  const response = await send({ messageDisposition: 'next_work' });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().status, 'queued');
  assert.equal(store.getOwnerComposerDraft(OWNER, THREAD).text, '');
});

test('an idempotent replay cannot consume a newer same-content draft even in the same millisecond', async (t) => {
  t.mock.method(Date, 'now', () => 100);
  const { send, store } = await fixture();
  const idempotencyKey = '1fea5e0d-4db8-42af-9745-0c0dadbe5701';
  assert.equal((await send({ idempotencyKey })).statusCode, 202);
  store.putOwnerComposerDraft(OWNER, THREAD, {
    expectedRevision: 2,
    text: TEXT,
    contentBlocks: BLOCKS,
    updatedAt: Date.now(),
  });
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  const response = await send({ idempotencyKey, composerDraftRevision: 3 });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().status, 'queued');
  assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
  assert.equal(response.json().composerDraftConsumption, undefined);
});

test('invalid draft revisions are rejected without consuming any owner state', async () => {
  const { send, store } = await fixture();
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  for (const composerDraftRevision of [-1, 0.5, null, true, '', 'NaN', [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await send({ composerDraftRevision })).statusCode, 400, String(composerDraftRevision));
    assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
  }
});

for (const operation of ['read', 'clear']) {
  for (const queued of [false, true]) {
    test(
      `a draft ${operation} failure preserves one ${queued ? 'queue admission' : 'default Queue admission'}`,
      { timeout: 5000 },
      async () => {
        const { send, store, dispatches, invocationQueue } = await fixture({ queue: queued });
        const method = operation === 'read' ? 'getOwnerComposerDraft' : 'clearOwnerComposerDraft';
        store[method] = async () => {
          throw new Error('owner draft store down');
        };
        const response = await send(queued ? { messageDisposition: 'next_work' } : {});
        assert.equal(response.statusCode, 202, response.body);
        const body = response.json();
        assert.ok(body.userMessageId);
        assert.equal(body.composerDraftConsumption, undefined);
        assert.equal(store.getById(body.userMessageId).content, TEXT);
        {
          const entries = invocationQueue.list(THREAD, OWNER);
          assert.equal(entries.length, 1);
          assert.equal(entries[0].id, body.entryId);
          assert.equal(dispatches.length, 0);
        }
      },
    );
  }
}

test('an older mounted ticket cannot consume a newer draft already saved before the send', async () => {
  const { send, store } = await fixture();
  store.putOwnerComposerDraft(OWNER, THREAD, {
    expectedRevision: 1,
    text: '另一端后来保存的草稿',
    contentBlocks: BLOCKS,
    updatedAt: Date.now(),
  });
  const before = store.getOwnerComposerDraft(OWNER, THREAD);
  assert.equal(before.revision, 2);
  const response = await send({ composerDraftRevision: 1 });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(store.getOwnerComposerDraft(OWNER, THREAD), before);
  assert.equal(response.json().composerDraftConsumption, undefined);
});
