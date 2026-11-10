import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const THREAD = 'anchor-thread';
const USER = 'default-user';

async function fixture(t, { threadStore } = {}) {
  const messageStore = new MessageStore();
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    messageStore,
    socketManager: { broadcastAgentMessage() {} },
    ...(threadStore ? { threadStore } : {}),
  });
  await app.ready();
  t.after(() => app.close());
  const append = (content, extra = {}) =>
    messageStore.append(
      canonicalTestMessageInput({
        userId: USER,
        threadId: THREAD,
        content,
        mentions: [],
        ...extra,
      }),
    );
  const read = (query) => app.inject({ method: 'GET', url: `/api/messages?${new URLSearchParams(query)}` });
  return { app, messageStore, append, read };
}

test('anchor history returns a bounded canonical window ending at the exact anchor', async (t) => {
  const f = await fixture(t);
  const messages = [];
  for (let i = 0; i < 6; i++) {
    messages.push(f.append(`msg ${i}`, { timestamp: 1000 + i }));
  }

  const anchor = messages[2];
  const two = await f.read({ threadId: THREAD, anchorMessageId: anchor.id, limit: '2' });
  assert.equal(two.statusCode, 200, two.body);
  const body = two.json();
  assert.deepEqual(
    body.messages.map((message) => message.content),
    ['msg 1', 'msg 2'],
  );
  assert.equal(body.hasMore, true);
  assert.equal('nextCursor' in body, false);
  assert.equal(body.messages.filter((message) => message.id === anchor.id).length, 1);
  assert.equal(body.messages.at(-1).id, anchor.id);

  const one = await f.read({ threadId: THREAD, anchorMessageId: anchor.id, limit: '1' });
  assert.equal(one.statusCode, 200, one.body);
  const oneBody = one.json();
  assert.deepEqual(
    oneBody.messages.map((message) => message.id),
    [anchor.id],
  );
  assert.equal(oneBody.messages[0].content, 'msg 2');
  assert.equal(oneBody.hasMore, true);

  const older = await f.read({ threadId: THREAD, anchorMessageId: messages[0].id, limit: '2' });
  assert.equal(older.statusCode, 200, older.body);
  assert.deepEqual(
    older.json().messages.map((message) => message.content),
    ['msg 0'],
  );
  assert.equal(older.json().hasMore, false);
});

test('anchor history rejects anchor+before, missing, cross-thread, cross-owner and unreadable sources without leaking', async (t) => {
  const f = await fixture(t);
  const visible = f.append('visible anchor', { timestamp: 2000 });
  const otherThread = f.append('other thread secret', { timestamp: 2001, threadId: 'other-thread' });
  const otherOwner = f.append('other owner secret', { timestamp: 2002, userId: 'other-owner' });
  const queued = f.append('queued user secret', { timestamp: 2003, deliveryStatus: 'queued' });

  const conflict = await f.read({ threadId: THREAD, anchorMessageId: visible.id, before: '2100', limit: '2' });
  assert.equal(conflict.statusCode, 400, conflict.body);
  assert.equal(conflict.json().code, 'ANCHOR_BEFORE_CONFLICT');

  const missing = await f.read({ threadId: THREAD, anchorMessageId: 'missing-anchor', limit: '2' });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().code, 'ANCHOR_UNAVAILABLE');
  assert.equal(missing.body.includes('secret'), false);

  for (const [label, anchorId] of [
    ['cross-thread', otherThread.id],
    ['cross-owner', otherOwner.id],
    ['queued user', queued.id],
  ]) {
    const response = await f.read({ threadId: THREAD, anchorMessageId: anchorId, limit: '2' });
    assert.equal(response.statusCode, 404, `${label}: ${response.body}`);
    assert.equal(response.json().code, 'ANCHOR_UNAVAILABLE', label);
    assert.equal(response.body.includes('secret'), false, label);
  }
});

test('anchor history returns a typed recalled result without the old body', async (t) => {
  const f = await fixture(t);
  const recalled = f.append('recalled secret body', { timestamp: 3000 });
  f.messageStore.getById(recalled.id).recall = {
    version: 1,
    exposure: 'none',
    recalledAt: 3100,
  };

  const response = await f.read({ threadId: THREAD, anchorMessageId: recalled.id, limit: '1' });
  assert.equal(response.statusCode, 410, response.body);
  assert.equal(response.json().code, 'ANCHOR_RECALLED');
  assert.equal(response.body.includes('secret'), false);
});

test('anchor history is bounded to one older batch even behind a long internal cluster', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) {
    f.append(`internal ${i}`, {
      timestamp: 1000 + i,
      userId: 'scheduler',
      from: { kind: 'system', service: 'routing-guard-failure' },
      source: { connector: 'routing-guard-failure', label: 'routing guard' },
    });
  }
  const anchor = f.append('bounded visible anchor', { timestamp: 3000 });
  let calls = 0;
  const original = f.messageStore.getByThreadBefore.bind(f.messageStore);
  f.messageStore.getByThreadBefore = (...args) => {
    calls += 1;
    return original(...args);
  };

  const response = await f.read({ threadId: THREAD, anchorMessageId: anchor.id, limit: '1' });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response.json().messages.map((message) => message.id),
    [anchor.id],
  );
  assert.equal(calls, 1);
  assert.equal(response.json().hasMore, true);
});

test('anchor history verifies thread ownership before allowing a system-user anchor', async (t) => {
  const systemAnchor = (f) =>
    f.append('system anchor body', {
      timestamp: 4000,
      userId: 'scheduler',
      from: { kind: 'system', service: 'test' },
    });

  const noThreadStore = await fixture(t);
  const noStoreAnchor = systemAnchor(noThreadStore);
  const noStoreRead = await noThreadStore.read({
    threadId: THREAD,
    anchorMessageId: noStoreAnchor.id,
    limit: '1',
  });
  assert.equal(noStoreRead.statusCode, 404, noStoreRead.body);
  assert.equal(noStoreRead.json().code, 'ANCHOR_UNAVAILABLE');
  assert.equal(noStoreRead.body.includes('system anchor body'), false);

  const foreignThread = await fixture(t, {
    threadStore: { get: async (id) => (id === THREAD ? { createdBy: 'other-owner' } : null) },
  });
  const foreignAnchor = systemAnchor(foreignThread);
  const foreignRead = await foreignThread.read({
    threadId: THREAD,
    anchorMessageId: foreignAnchor.id,
    limit: '1',
  });
  assert.equal(foreignRead.statusCode, 404, foreignRead.body);
  assert.equal(foreignRead.json().code, 'ANCHOR_UNAVAILABLE');
  assert.equal(foreignRead.body.includes('system anchor body'), false);

  const ownedThread = await fixture(t, {
    threadStore: { get: async (id) => (id === THREAD ? { createdBy: USER } : null) },
  });
  const ownedAnchor = systemAnchor(ownedThread);
  const ownedRead = await ownedThread.read({ threadId: THREAD, anchorMessageId: ownedAnchor.id, limit: '1' });
  assert.equal(ownedRead.statusCode, 200, ownedRead.body);
  assert.deepEqual(
    ownedRead.json().messages.map((message) => message.id),
    [ownedAnchor.id],
  );

  const systemThread = await fixture(t, {
    threadStore: { get: async (id) => (id === THREAD ? { createdBy: 'system' } : null) },
  });
  const systemThreadAnchor = systemAnchor(systemThread);
  const systemThreadRead = await systemThread.read({
    threadId: THREAD,
    anchorMessageId: systemThreadAnchor.id,
    limit: '1',
  });
  assert.equal(systemThreadRead.statusCode, 200, systemThreadRead.body);
  assert.deepEqual(
    systemThreadRead.json().messages.map((message) => message.id),
    [systemThreadAnchor.id],
  );

  const defaultLobby = await fixture(t, {
    threadStore: { get: async (id) => (id === 'default' ? { createdBy: 'system' } : null) },
  });
  const defaultAnchor = defaultLobby.append('default lobby system anchor', {
    threadId: 'default',
    timestamp: 4100,
    userId: 'scheduler',
    from: { kind: 'system', service: 'test' },
  });
  const defaultRead = await defaultLobby.read({
    threadId: 'default',
    anchorMessageId: defaultAnchor.id,
    limit: '1',
  });
  assert.equal(defaultRead.statusCode, 200, defaultRead.body);
  assert.deepEqual(
    defaultRead.json().messages.map((message) => message.id),
    [defaultAnchor.id],
  );
});

test('anchor snapshots do not recover newer publications or acknowledge their History frontier', async (t) => {
  const f = await fixture(t);
  const anchor = f.append('old response', { timestamp: 1000 });
  const initial = await f.read({ threadId: THREAD, limit: '1' });
  const applied = initial.json().historyWatermark;
  assert.equal(typeof applied, 'string');
  const newer = f.append('newer publication', { timestamp: 2000 });

  for (const query of [{}, { afterVisibility: applied }]) {
    const snapshot = await f.read({ threadId: THREAD, anchorMessageId: anchor.id, limit: '1', ...query });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.deepEqual(
      snapshot.json().messages.map((message) => message.id),
      [anchor.id],
    );
    assert.equal(Object.hasOwn(snapshot.json(), 'historyWatermark'), false);
    assert.equal(Object.hasOwn(snapshot.json(), 'historyPageCursor'), false);
  }

  const recovered = await f.read({ threadId: THREAD, limit: '1', afterVisibility: applied });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.ok(recovered.json().messages.some((message) => message.id === newer.id));
  assert.notEqual(recovered.json().historyWatermark, applied);
});
