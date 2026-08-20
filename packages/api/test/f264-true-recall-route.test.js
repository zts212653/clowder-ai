import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Fastify from 'fastify';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messageActionsRoutes } from '../dist/routes/message-actions.js';

const THREAD_ID = 'thread-f264-gap-f-route';
const OWNER_ID = 'owner-f264-gap-f';
const AUTH_HEADERS = { 'x-cat-cafe-user': OWNER_ID };

function queueCustody(entryId, overrides = {}) {
  return {
    version: 1,
    entryId,
    revision: 1,
    ownerAuthProvenance: 'strict',
    intent: 'user_message',
    status: 'queued',
    allTargetCats: ['codex', 'fable5'],
    pendingTargetCats: ['codex', 'fable5'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function queueEntry(entryId, messages, overrides = {}) {
  return {
    id: entryId,
    threadId: THREAD_ID,
    userId: OWNER_ID,
    ownerAuthProvenance: 'strict',
    content: messages.map((message) => message.content).join('\n\n'),
    messageId: messages[0]?.id ?? null,
    mergedMessageIds: messages.slice(1).map((message) => message.id),
    source: 'user',
    targetCats: ['codex', 'fable5'],
    allTargetCats: ['codex', 'fable5'],
    intent: 'user_message',
    status: 'queued',
    createdAt: 100,
    autoExecute: false,
    priority: 'normal',
    ...overrides,
  };
}

function appendQueued(messageStore, entryId, content, overrides = {}) {
  return messageStore.append({
    threadId: THREAD_ID,
    userId: OWNER_ID,
    catId: null,
    content,
    mentions: ['codex', 'fable5'],
    timestamp: 1_000 + content.length,
    deliveryStatus: 'queued',
    queueCustody: queueCustody(entryId, overrides.custody),
    ...overrides.message,
  });
}

function createHarness(overrides = {}) {
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  threadStore.ensureThread(THREAD_ID, 'Gap F route test');
  const invocationQueue = new InvocationQueue();
  const queueCustodyCoordinator =
    overrides.queueCustodyCoordinatorFactory?.({ messageStore, invocationQueue }) ??
    new QueuedMessageCustodyCoordinator({ messageStore });
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
    queueCustodyCoordinator,
    queueProcessor,
    indexBuilder,
    socketManager,
  });
  return {
    app,
    messageStore,
    threadStore,
    invocationQueue,
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
    const message = appendQueued(harness.messageStore, 'entry-authorization', '只能由原 owner 在原 thread 撤回');
    const entry = queueEntry('entry-authorization', [message]);
    harness.invocationQueue.restoreDurableEntry(entry);

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
    assert.deepEqual(harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, entry.id), entry);
    assert.equal(harness.messageStore.getById(message.id).content, '只能由原 owner 在原 thread 撤回');
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
    assert.equal(harness.messageStore.getOwnerComposerDraft('foreign-owner', THREAD_ID), null);
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, 'thread-foreign'), null);
  });

  it('atomically removes a zero-exposure carrier and returns the body only in the owner draft', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-one', '打错的正文');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-one', [message]));

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
    assert.deepEqual(harness.unregisteredEntries, ['entry-one']);
    assert.deepEqual(harness.finalizedEntries, ['entry-one']);
    assert.ok(harness.socketEvents.some((event) => event.event === 'message_recalled'));
  });

  it('replays an already committed recall without appending the body a second time', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-repeat', '只应回填一次');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-repeat', [message]));

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
    const message = appendQueued(harness.messageStore, 'entry-conflict', '不能丢的正文');
    const entry = queueEntry('entry-conflict', [message], { position: 3 });
    harness.invocationQueue.restoreDurableEntry(entry);
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
    assert.deepEqual(harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, entry.id), entry);
    assert.equal(harness.messageStore.getById(message.id).content, '不能丢的正文');
    assert.deepEqual(harness.suppressedPassages, [{ threadId: THREAD_ID, messageId: message.id }]);
    assert.deepEqual(harness.releasedPassages, [{ threadId: THREAD_ID, messageId: message.id, leaseId: 'lease-1' }]);
  });

  it('scrubs an exact first-message-derived thread title when recall commits', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-derived-title', '打错且成为标题的正文');
    harness.threadStore.updateTitle(THREAD_ID, message.content);
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-derived-title', [message]));

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
    const message = appendQueued(harness.messageStore, 'entry-custom-title', '正文不是标题');
    harness.threadStore.updateTitle(THREAD_ID, '用户亲自改的标题');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-custom-title', [message]));

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
    const message = appendQueued(harness.messageStore, 'entry-title-rollback', '失败后仍是原标题');
    harness.threadStore.updateTitle(THREAD_ID, message.content);
    const entry = queueEntry('entry-title-rollback', [message]);
    harness.invocationQueue.restoreDurableEntry(entry);
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

  it('does not let a losing concurrent recall restore a title after the winning recall commits', async () => {
    let firstCommitEntered;
    let releaseFirstCommit;
    const firstCommitReady = new Promise((resolve) => {
      firstCommitEntered = resolve;
    });
    const firstCommitGate = new Promise((resolve) => {
      releaseFirstCommit = resolve;
    });
    let commitCalls = 0;
    const harness = createHarness({
      queueCustodyCoordinatorFactory({ messageStore }) {
        const canonical = new QueuedMessageCustodyCoordinator({ messageStore });
        return {
          async recallMessageToComposerDraft(...args) {
            commitCalls += 1;
            if (commitCalls === 1) {
              firstCommitEntered();
              await firstCommitGate;
            }
            return canonical.recallMessageToComposerDraft(...args);
          },
        };
      },
    });
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-title-concurrent', '并发撤回后也不能回露的标题正文');
    harness.threadStore.updateTitle(THREAD_ID, message.content);
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-title-concurrent', [message]));

    const losingRequest = harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });
    await firstCommitReady;
    const winningResponse = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });
    releaseFirstCommit();
    const losingResponse = await losingRequest;

    assert.equal(winningResponse.statusCode, 200, winningResponse.body);
    assert.equal(winningResponse.json().verdict, 'zero_exposure');
    assert.equal(losingResponse.statusCode, 409, losingResponse.body);
    assert.equal(losingResponse.json().code, 'QUEUE_CARRIER_CHANGED');
    assert.equal(harness.messageStore.getById(message.id).content, '');
    assert.equal(
      harness.threadStore.get(THREAD_ID).title,
      `Thread ${THREAD_ID.slice(0, 12)}`,
      'a committed lease must fence the losing request from restoring the recalled body',
    );
  });

  it('rejects a concurrently changed Queue carrier without rolling it back or moving the body', async () => {
    let harness;
    const changedEntry = { current: null };
    harness = createHarness({
      indexBuilder: {
        async suppressMessagePassage(threadId, messageId) {
          harness.suppressedPassages.push({ threadId, messageId });
          const current = harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, 'entry-carrier-race');
          assert.ok(current);
          changedEntry.current = { ...current, priority: 'urgent' };
          assert.equal(harness.invocationQueue.restoreEntrySnapshotIfUnchanged(current, changedEntry.current), true);
          return { threadId, messageId, leaseId: 'lease-carrier-race' };
        },
      },
    });
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-carrier-race', '并发期间不能搬走');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-carrier-race', [message]));

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'QUEUE_CARRIER_CHANGED');
    assert.deepEqual(
      harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, 'entry-carrier-race'),
      changedEntry.current,
      'the newer Queue snapshot must remain authoritative',
    );
    assert.equal(harness.messageStore.getById(message.id).content, '并发期间不能搬走');
    assert.equal(harness.messageStore.getOwnerComposerDraft(OWNER_ID, THREAD_ID), null);
    assert.deepEqual(harness.releasedPassages, [
      { threadId: THREAD_ID, messageId: message.id, leaseId: 'lease-carrier-race' },
    ]);
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
    const message = appendQueued(harness.messageStore, 'entry-index-fail', '必须原样保留');
    const entry = queueEntry('entry-index-fail', [message]);
    harness.invocationQueue.restoreDurableEntry(entry);

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
    assert.deepEqual(harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, entry.id), entry);
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
    const message = appendQueued(harness.messageStore, 'entry-finalize-fail', '仍应回填');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-finalize-fail', [message]));

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

  it('removes only the recalled member from a coalesced carrier', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const first = appendQueued(harness.messageStore, 'entry-merged', '第一条错字');
    const second = appendQueued(harness.messageStore, 'entry-merged', '第二条保留');
    harness.invocationQueue.restoreDurableEntry(queueEntry('entry-merged', [first, second]));

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${first.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const remaining = harness.invocationQueue.getEntrySnapshot(THREAD_ID, OWNER_ID, 'entry-merged');
    assert.ok(remaining);
    assert.equal(remaining.messageId, second.id);
    assert.deepEqual(remaining.mergedMessageIds, []);
    assert.equal(remaining.content, '第二条保留');
    assert.deepEqual(harness.finalizedEntries, [], 'a surviving sibling still owns the carrier');
  });

  it('keeps an exposed recall content-free while returning exact exposure truth', async () => {
    const harness = createHarness();
    apps.push(harness.app);
    const message = appendQueued(harness.messageStore, 'entry-seen', '猫已经读过', {
      custody: {
        seenByCatIds: ['codex'],
        seenInvocationIdByCatId: { codex: 'child-read' },
        bodyExposures: [{ targetCatId: 'codex', invocationId: 'child-read', seenAt: 1_500 }],
      },
    });
    harness.invocationQueue.restoreDurableEntry(
      queueEntry('entry-seen', [message], {
        status: 'processing',
        processingStartedAt: 1_400,
        queuedSeenByCatIds: ['codex'],
        queuedSeenInvocationIdByCatId: { codex: 'child-read' },
        queuedBodyExposures: [{ targetCatId: 'codex', invocationId: 'child-read', seenAt: 1_500 }],
      }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: AUTH_HEADERS,
      payload: { threadId: THREAD_ID, expectedDraftRevision: 0, merge: 'replace' },
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.verdict, 'exposed');
    assert.deepEqual(body.message.recall.exposures, [
      { targetCatId: 'codex', invocationId: 'child-read', seenAt: 1_500 },
    ]);
    assert.equal(body.message.content, undefined);
    assert.equal(harness.invocationQueue.list(THREAD_ID, OWNER_ID).length, 0);
  });
});
