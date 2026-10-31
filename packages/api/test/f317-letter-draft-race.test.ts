import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionDraftSource } from '../src/domains/concierge/live/host/companion-draft-source.js';
import { composerDraftRecallRoutes } from '../src/routes/composer-draft-recall.js';

test('a rich draft winning the save CAS returns readonly and keeps its original body', async () => {
  const store = new MessageStore();
  store.putOwnerComposerDraft('owner', 'home', { expectedRevision: 0, text: 'Plain', updatedAt: 100 });
  const drafts = new CompanionDraftSource({
    ownerUserId: 'owner',
    messages: store,
    client: {
      async request() {
        return {};
      },
    },
    conversationThread: async () => 'home',
    currentCallId: () => undefined,
    assertCurrent: async () => {},
  });
  const original = await drafts.current();
  const put = store.putOwnerComposerDraft.bind(store);
  store.putOwnerComposerDraft = (owner, thread, input) => {
    put(owner, thread, { expectedRevision: 1, text: 'Rich winner', replyTo: 'parent', updatedAt: 101 });
    return put(owner, thread, input);
  };
  assert.deepEqual(await drafts.save(original.scopeRef, original.revision, 'Replacement'), {
    kind: 'conversation-draft',
    v: 1,
    status: 'readonly',
    revision: 2,
  });
  assert.equal(store.getOwnerComposerDraft('owner', 'home')?.text, 'Rich winner');
  assert.equal(store.getOwnerComposerDraft('owner', 'home')?.replyTo, 'parent');
});

test('the existing composer HTTP API neither exposes nor accepts Host-only send recovery metadata', async (t) => {
  const store = new MessageStore();
  const pending = {
    clientMessageId: randomUUID(),
    text: 'Pending',
    callId: null,
    submissionRevision: 0,
    reservationRevision: 1,
    createdAt: 100,
  };
  store.putOwnerComposerDraft('owner', 'home', {
    expectedRevision: 0,
    text: 'Draft',
    updatedAt: 100,
    companionSubmissions: [pending],
  });
  const app = Fastify();
  t.after(() => app.close());
  await app.register(composerDraftRecallRoutes, {
    messageStore: store,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  const headers = { 'x-cat-cafe-user': 'owner' };
  const read = await app.inject({ method: 'GET', url: '/api/threads/home/composer-draft', headers });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(Object.hasOwn(read.json().draft, 'companionSubmissions'), false);
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/threads/home/composer-draft',
    headers,
    payload: { expectedRevision: 1, text: 'New draft' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(Object.hasOwn(saved.json().draft, 'companionSubmissions'), false);
  const forged = await app.inject({
    method: 'PUT',
    url: '/api/threads/home/composer-draft',
    headers,
    payload: { expectedRevision: 2, text: 'Forged', companionSubmissions: [] },
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.deepEqual(store.getOwnerComposerDraft('owner', 'home')?.companionSubmissions, [pending]);
});
