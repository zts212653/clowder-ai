import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { threadsRoutes } from '../src/routes/threads.js';

const owner = 'widget-read-owner';
const threadId = 'thread-widget-read';
const messageId = 'msg-widget-read';
const html = '<!doctype html><html><body><button id="b">click me</button></body></html>';

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: messageId,
    threadId,
    userId: owner,
    catId: 'opus-48',
    from: { kind: 'agent', catId: 'opus-48' },
    content: '',
    timestamp: 1_700_000_000_000,
    deliveryStatus: 'delivered',
    extra: {
      rich: {
        blocks: [
          { kind: 'html_widget', v: 1, id: 'widget-a', html, title: '同名' },
          { kind: 'html_widget', v: 1, id: 'widget-b', html, title: '同名' },
          { kind: 'interactive', v: 1, id: 'choice-a', interactiveType: 'select', options: [] },
        ],
      },
    },
    ...overrides,
  } as StoredMessage;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    projectPath: 'default',
    title: 'Widget read fixture',
    createdBy: owner,
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    ...overrides,
  } as Thread;
}

async function request(input: {
  thread?: Thread | null;
  messages?: Map<string, StoredMessage>;
  user?: string | null;
  blockId?: string;
  messageId?: string;
  threadId?: string;
}) {
  const app = Fastify();
  await app.register(threadsRoutes, {
    threadStore: {
      get: async (id: string) => (input.thread && id === input.thread.id ? input.thread : null),
    } as never,
    messageStore: {
      getById: async (id: string) => input.messages?.get(id) ?? null,
    } as never,
    presenceSource: {} as never,
  });
  await app.ready();
  try {
    const headers: Record<string, string> = {};
    // `resolveUserId(request, {})` only reads a session or a non-browser header.
    if (input.user !== null) headers['x-cat-cafe-user'] = input.user ?? owner;
    return await app.inject({
      method: 'GET',
      url:
        `/api/threads/${input.threadId ?? threadId}/artifacts/` +
        `${input.messageId ?? messageId}/blocks/${input.blockId ?? 'widget-a'}`,
      headers,
    });
  } finally {
    await app.close();
  }
}

test('reads the exact html_widget block named by the coordinate', async () => {
  const response = await request({ thread: thread(), messages: new Map([[messageId, message()]]) });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.block.id, 'widget-a');
  assert.equal(body.block.kind, 'html_widget');
  assert.equal(body.block.html, html);
});

test('two same-name widgets in one message resolve to their own block', async () => {
  const messages = new Map([[messageId, message()]]);
  const first = await request({ thread: thread(), messages, blockId: 'widget-a' });
  const second = await request({ thread: thread(), messages, blockId: 'widget-b' });
  assert.equal(first.json().block.id, 'widget-a');
  assert.equal(second.json().block.id, 'widget-b');
});

test('no identity is 401, not default-user', async () => {
  const response = await request({
    thread: thread(),
    messages: new Map([[messageId, message()]]),
    user: null,
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'Identity required');
});

test('the sibling artefacts route admission applies: missing thread 404, other owner 403', async () => {
  const missing = await request({ thread: null, messages: new Map() });
  assert.equal(missing.statusCode, 404);
  const foreign = await request({
    thread: thread({ createdBy: 'someone-else' }),
    messages: new Map([[messageId, message()]]),
  });
  assert.equal(foreign.statusCode, 403);
});

test('a system thread admits an ordinary authenticated user, but only for their own messages', async () => {
  const sharedThread = thread({ createdBy: 'system' });
  const own = await request({ thread: sharedThread, messages: new Map([[messageId, message()]]) });
  assert.equal(own.statusCode, 200);
  const foreign = await request({
    thread: sharedThread,
    messages: new Map([[messageId, message({ userId: 'another-user' })]]),
  });
  assert.equal(foreign.statusCode, 404);
});

test('a system-user message is readable because the catalogue lists it', async () => {
  const response = await request({
    thread: thread(),
    messages: new Map([[messageId, message({ userId: 'system', from: { kind: 'system', service: 'scheduler' } })]]),
  });
  assert.equal(response.statusCode, 200);
});

test('another user, a deleted message and queued user work are all unavailable', async () => {
  for (const stored of [
    message({ userId: 'another-user' }),
    message({ deletedAt: 1 }),
    message({ deliveryStatus: 'queued', catId: null, from: { kind: 'user', userId: owner } }),
  ]) {
    const response = await request({ thread: thread(), messages: new Map([[messageId, stored]]) });
    assert.equal(response.statusCode, 404, JSON.stringify(stored.deliveryStatus));
  }
});

test('queued cat speech stays readable, matching the catalogue read', async () => {
  const response = await request({
    thread: thread(),
    messages: new Map([[messageId, message({ deliveryStatus: 'queued' })]]),
  });
  assert.equal(response.statusCode, 200);
});

test('a block that is not html_widget, a missing block, or a wrong thread is unavailable', async () => {
  const messages = new Map([[messageId, message()]]);
  assert.equal((await request({ thread: thread(), messages, blockId: 'choice-a' })).statusCode, 404);
  assert.equal((await request({ thread: thread(), messages, blockId: 'gone' })).statusCode, 404);
  assert.equal((await request({ thread: thread(), messages, threadId: 'other-thread' })).statusCode, 404);
});
