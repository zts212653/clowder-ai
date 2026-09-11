import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Fastify from 'fastify';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const THREAD_ID = 'thread-f264-gap-f-route';
const OWNER_ID = 'owner-f264-gap-f';
const AUTH_HEADERS = { 'x-cat-cafe-user': OWNER_ID };

async function appendQueued(harness, content, targetCats = ['codex', 'fable5']) {
  const message = harness.messageStore.append(
    canonicalTestMessageInput({
      threadId: THREAD_ID,
      userId: OWNER_ID,
      catId: null,
      content,
      mentions: ['codex', 'fable5'],
      timestamp: 1_000 + content.length,
    }),
  );
  const admission = await harness.invocationQueue.enqueueExistingMessageDurable(harness.messageStore, message.id, {
    threadId: THREAD_ID,
    userId: OWNER_ID,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content,
    messageId: message.id,
    from: { kind: 'user', userId: OWNER_ID },
    targetCats,
    intent: 'user_message',
    autoExecute: false,
    priority: 'normal',
  });
  assert.equal(admission.outcome, 'enqueued');
  return { message: admission.message, entries: admission.entries };
}

function createHarness(overrides = {}) {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  threadStore.ensureThread(THREAD_ID, 'Gap F route test');
  const ledgerStore = overrides.ledgerStore ?? new InMemoryQueueLedgerStore();
  const invocationQueue = new InvocationQueue(ledgerStore);
  const socketEvents = [];
  const finalizedEntries = [];
  const unregisteredEntries = [];
  const suppressedPassages = [];
  const releasedPassages = [];
  const finalizedPassages = [];
  const suppressionStates = new Map();
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom(room, event, data) {
      socketEvents.push({ room, event, data });
    },
    emitToUser(userId, event, data) {
      socketEvents.push({ userId, event, data });
    },
  };
  const queueProcessor = {
    unregisterEntryCompleteHook(entryId) {
      unregisteredEntries.push(entryId);
    },
    async finalizeRemovedEntry(entry) {
      finalizedEntries.push(entry?.id);
    },
    ...overrides.queueProcessor,
  };
  const indexBuilder = {
    async suppressMessagePassage(threadId, messageId) {
      suppressedPassages.push({ threadId, messageId });
      const lease = { threadId, messageId, leaseId: `lease-${suppressedPassages.length}` };
      suppressionStates.set(lease.leaseId, { ...lease, state: 'prepared' });
      return lease;
    },
    async releaseMessagePassageSuppression(lease) {
      releasedPassages.push(lease);
      const current = suppressionStates.get(lease.leaseId);
      if (!current || current.state !== 'prepared') return false;
      suppressionStates.delete(lease.leaseId);
      return ![...suppressionStates.values()].some(
        (candidate) => candidate.threadId === lease.threadId && candidate.messageId === lease.messageId,
      );
    },
    async finalizeMessagePassageSuppression(lease) {
      finalizedPassages.push(lease);
      for (const state of suppressionStates.values()) {
        if (state.threadId === lease.threadId && state.messageId === lease.messageId) state.state = 'committed';
      }
    },
    ...overrides.indexBuilder,
  };
  const app = Fastify();
  app.register(messageActionsRoutes, {
    messageStore,
    threadStore,
    invocationQueue,
    queueProcessor,
    indexBuilder,
    socketManager,
  });
  return {
    app,
    messageStore,
    threadStore,
    invocationQueue,
    ledgerStore,
    socketEvents,
    finalizedEntries,
    unregisteredEntries,
    suppressedPassages,
    releasedPassages,
    finalizedPassages,
  };
}

const apps = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('F264 Gap F true recall API', () => {
  it('rejects foreign-owner and foreign-thread recall before suppression or queue mutation', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '只能由原 owner 在原 thread 撤回');

    const foreignOwner = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: { 'x-cat-cafe-user': 'foreign-owner' },
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });
    const foreignThread = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: 'thread-foreign', expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(foreignOwner.statusCode, 403, foreignOwner.body);
    assert.equal(foreignThread.statusCode, 403, foreignThread.body);
    assert.deepEqual(harness.suppressedPassages, []);
    assert.deepEqual(harness.releasedPassages, []);
    assert.deepEqual(harness.finalizedPassages, []);
    assert.deepEqual(
      harness.invocationQueue
        .list(THREAD_ID, OWNER_ID)
        .map((entry) => entry.id)
        .sort(),
      entries.map((entry) => entry.id).sort(),
    );
    assert.equal(harness.messageStore.getById(message.id).content, '只能由原 owner 在原 thread 撤回');
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
    assert.equal(harness.messageStore.getOwnerComposerDraft('foreign-owner', THREAD_ID), null);
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, 'thread-foreign'), null);
  });

  it('atomically removes a zero-exposure carrier and returns the body only in the owner draft', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '打错的正文');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.verdict, 'zero_exposure');
    assert.equal(body.draft.text, '打错的正文');
    assert.deepEqual(body.insertedRange, { start: 0, end: 5 });
    assert.equal(body.message.content, undefined, 'the tombstone ACK must not project a second body copy');
    assert.equal(harness.invocationQueue.list(THREAD_ID, OWNER_ID).length, 0);
    assert.equal(harness.messageStore.getById(message.id).content, '');
    assert.deepEqual(harness.suppressedPassages, [{ threadId: THREAD_ID, messageId: message.id }]);
    assert.deepEqual(harness.releasedPassages, []);
    assert.deepEqual(
      harness.unregisteredEntries,
      entries.map((entry) => entry.id),
    );
    assert.deepEqual(
      harness.finalizedEntries,
      entries.map((entry) => entry.id),
    );
    assert.ok(harness.socketEvents.some((event) => event.event === 'message_recalled'));
  });

  it('replays an already committed recall without appending the body a second time', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '只应回填一次');

    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });
    const repeat = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 1, merge: 'append' },
    });

    assert.equal(first.statusCode, 200, first.body);
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(repeat.json().verdict, 'already_recalled');
    assert.equal(repeat.json().draft.text, '只应回填一次');
    assert.equal(repeat.json().draft.revision, 1);
    assert.equal(repeat.json().insertedRange, null);
  });

  it('restores the exact Queue snapshot when the owner draft revision is stale', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '不能丢的正文');
    harness.messageStore.putOwnerComposerDraft(OWNER_ID, THREAD_ID, {
      expectedRevision: 0,
      text: '并发编辑的新草稿',
      updatedAt: 1_500,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'append' },
    });

    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { code: 'DRAFT_REVISION_MISMATCH', actualRevision: 1 });
    assert.deepEqual(
      harness.invocationQueue
        .list(THREAD_ID, OWNER_ID)
        .map((entry) => ({ id: entry.id, status: entry.status }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      entries
        .map((entry) => ({ id: entry.id, status: 'queued' }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
    assert.equal(harness.messageStore.getById(message.id).content, '不能丢的正文');
    assert.deepEqual(harness.suppressedPassages, [{ threadId: THREAD_ID, messageId: message.id }]);
    assert.deepEqual(harness.releasedPassages, [{ threadId: THREAD_ID, messageId: message.id, leaseId: 'lease-1' }]);
  });

  it('scrubs an exact first-message-derived thread title when recall commits', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '打错且成为标题的正文');
    harness.threadStore.updateTitle(THREAD_ID, message.content);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(harness.threadStore.get(THREAD_ID).title, `Thread ${THREAD_ID.slice(0, 12)}`);
  });

  it('preserves a custom thread title when recalling the first message', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '正文不是标题');
    harness.threadStore.updateTitle(THREAD_ID, '用户亲自改的标题');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(harness.threadStore.get(THREAD_ID).title, '用户亲自改的标题');
  });

  it('restores a prepared derived title when canonical recall is rejected', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '失败后仍是原标题');
    harness.threadStore.updateTitle(THREAD_ID, message.content);
    harness.messageStore.putOwnerComposerDraft(OWNER_ID, THREAD_ID, {
      expectedRevision: 0,
      text: '并发草稿',
      updatedAt: 1_500,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(harness.threadStore.get(THREAD_ID).title, message.content);
  });

  it('rejects recall while the single pending Queue entry is claimed by another operation', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '已经出队的正文');
    const claim = await harness.invocationQueue.claimMessageEntriesForWithdrawal(
      THREAD_ID,
      OWNER_ID,
      message.id,
      1_500,
    );
    assert.equal(claim.outcome, 'claimed');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'ENTRY_PROCESSING');
    assert.equal(harness.messageStore.getById(message.id).content, '已经出队的正文');
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
    assert.equal(harness.invocationQueue.list(THREAD_ID, OWNER_ID).length, 1);
  });

  it('fails before the canonical CAS and restores Queue when index suppression cannot be prepared', async () => {
    const harness = createHarness({
      indexBuilder: {
        async suppressMessagePassage() {
          throw new Error('sqlite unavailable');
        },
      },
    });
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '必须原样保留');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'RECALL_INDEX_PREPARE_FAILED');
    assert.equal(harness.messageStore.getById(message.id).content, '必须原样保留');
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
    assert.deepEqual(
      harness.invocationQueue
        .list(THREAD_ID, OWNER_ID)
        .map((entry) => entry.id)
        .sort(),
      entries.map((entry) => entry.id).sort(),
    );
    assert.deepEqual(harness.releasedPassages, []);
  });

  it('returns the authoritative committed ACK even when Queue record cleanup needs startup recovery', async () => {
    const harness = createHarness({
      queueProcessor: {
        async finalizeRemovedEntry() {
          throw new Error('record store unavailable');
        },
      },
    });
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '仍应回填');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().draft.text, '仍应回填');
    assert.equal(harness.messageStore.getById(message.id).content, '');
    assert.equal(harness.invocationQueue.list(THREAD_ID, OWNER_ID).length, 0);
  });

  it('removes an interrupted recall claim from the recalled message on startup', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message, entries } = await appendQueued(harness, '消息已提交但进程还没提交 Queue');
    const claim = await harness.invocationQueue.claimMessageEntriesForWithdrawal(
      THREAD_ID,
      OWNER_ID,
      message.id,
      1_500,
    );
    assert.equal(claim.outcome, 'claimed');
    assert.equal(
      harness.messageStore.recallMessageToComposerDraft(message.id, {
        ownerUserId: OWNER_ID,
        threadId: THREAD_ID,
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: 1_600,
      }).kind,
      'recalled',
    );

    const restarted = new InvocationQueue(harness.ledgerStore);
    assert.equal(await restarted.hydrateFromLedger(harness.messageStore), 0);
    assert.deepEqual(restarted.list(THREAD_ID, OWNER_ID), []);
    for (const entry of entries) {
      assert.equal(await harness.ledgerStore.get(THREAD_ID, entry.id), null);
    }
  });

  it('recalls one message without changing a later independent Queue item', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const first = await appendQueued(harness, '第一条错字');
    const second = await appendQueued(harness, '第二条保留');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${first.message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const remaining = harness.invocationQueue.list(THREAD_ID, OWNER_ID);
    assert.deepEqual(remaining.map((entry) => entry.id).sort(), second.entries.map((entry) => entry.id).sort());
    assert.ok(
      remaining.every(
        (entry) => entry.payload.messageId === second.message.id && entry.payload.content === '第二条保留',
      ),
    );
    assert.deepEqual(
      harness.finalizedEntries,
      first.entries.map((entry) => entry.id),
    );
  });

  it('keeps a pending recall content-free with zero exposure', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const { message } = await appendQueued(harness, '仍在等待投递', ['codex']);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.verdict, 'zero_exposure');
    assert.equal(body.message.recall.exposures, undefined);
    assert.equal(body.message.content, undefined);
    assert.equal(harness.invocationQueue.list(THREAD_ID, OWNER_ID).length, 0);
  });
});
