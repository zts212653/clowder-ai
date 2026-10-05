import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { LiveInbox } from '../src/domains/concierge/live/inbox/LiveInbox.ts';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.ts';
import { callbacksRoutes } from '../src/routes/callbacks.ts';

async function fixture(intent, source = 'user') {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const registry = new InvocationRegistry();
  const cursorStore = new DeliveryCursorStore();
  const auth = await registry.create('owner', 'codex-astra', 'home', 'live-parent');
  const entry = queue.enqueue({
    threadId: 'home',
    userId: 'owner',
    ownerAuthProvenance: 'strict',
    content: 'actual queued body',
    source,
    targetCats: ['codex-astra'],
    intent: 'execute',
    ...(intent ? { authorIntentByCatId: { 'codex-astra': intent } } : {}),
  }).entry;
  assert.ok(entry);
  const message = store.append({
    threadId: 'home',
    userId: 'owner',
    catId: source === 'agent' ? 'opus' : null,
    content: entry.content,
    mentions: ['codex-astra'],
    timestamp: entry.createdAt,
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  queue.backfillMessageId('home', 'owner', entry.id, message.id);
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: store,
    invocationQueue: queue,
    deliveryCursorStore: cursorStore,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: store }),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  const scope = {
    userId: 'owner',
    threadId: 'home',
    catId: 'codex-astra',
    invocationId: auth.invocationId,
    parentInvocationId: 'live-parent',
    callId: 'call',
    generation: 1,
  };
  const deliveries = [];
  const inbox = new LiveInbox({
    scope,
    source: new MessageLiveInboxSource({ store, queue, authorize: async () => true }),
    wake() {},
    deliver: async (batch) => {
      deliveries.push(batch);
      return 'accepted';
    },
  });
  const read = (query) =>
    app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?responseMode=full${query ?? ''}`,
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
  return { app, queue, store, message, entry, inbox, deliveries, read, scope, cursorStore };
}

test('idle next-work yields to the ordinary Queue without issuing an unreadable full-read notice', async () => {
  const f = await fixture({ requested: 'next_work' });
  try {
    assert.deepEqual(
      f.queue.getQueuedBodyMessagesForCat('home', 'owner', 'codex-astra', 'live-parent', f.scope.invocationId),
      [],
    );
    const hidden = await f.read('&readIntent=unread');
    assert.equal(hidden.statusCode, 200);
    assert.equal(
      hidden.json().messages.some((message) => message.id === f.message.id),
      false,
    );
    assert.equal((await f.read(`&messageId=${f.message.id}`)).statusCode, 404);
    const idle = await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false });
    assert.equal(idle.kind, 'successor_required');
    assert.equal(f.deliveries.length, 0);
    assert.deepEqual(
      idle.successorSources.map((item) => [item.messageId, item.queueEntryId]),
      [[f.message.id, f.entry.id]],
    );
    assert.equal(
      (await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false })).kind,
      'successor_required',
    );
    assert.equal(f.store.getById(f.message.id).queueCustody.notifiedByCatIds.length, 0);
    assert.equal(f.store.getById(f.message.id).queueCustody.bodyExposures, undefined);
    assert.equal(f.queue.peekNextQueued('home', 'owner').id, f.entry.id);
    // Ordinary successor selection still owns the body and ordering; C0 has not dequeued or settled it.
    assert.equal(f.queue.markProcessing('home', 'owner').content, 'actual queued body');
  } finally {
    f.inbox.close();
    await f.app.close();
  }
});

test('C0 notifications and the real full-read route agree on exact-parent and source-domain permission', async () => {
  const cases = [
    { name: 'legacy user', readable: false },
    {
      name: 'wrong parent',
      intent: { requested: 'continue_current', boundParentInvocationId: 'other' },
      readable: false,
    },
    {
      name: 'fallback to next work',
      intent: {
        requested: 'continue_current',
        boundParentInvocationId: 'live-parent',
        fallbackAt: 10,
        fallbackReason: 'parent_terminal_before_exposure',
      },
      readable: false,
    },
    {
      name: 'exact parent',
      intent: { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
      readable: true,
    },
    {
      name: 'connector ignores user-shaped intent',
      source: 'connector',
      intent: { requested: 'next_work' },
      readable: true,
    },
  ];
  for (const row of cases) {
    const f = await fixture(row.intent, row.source);
    try {
      const boundary = { kind: 'tool_complete', generation: 1, userSpeaking: false };
      await f.inbox.atBoundary(boundary);
      assert.equal(f.deliveries.length, row.readable ? 1 : 0, row.name);
      const response = await f.read('&readIntent=unread');
      assert.equal(response.statusCode, 200, `${row.name}: ${response.body}`);
      assert.equal(
        response
          .json()
          .messages.some((message) => message.id === f.message.id && message.content === 'actual queued body'),
        row.readable,
        row.name,
      );
      const idle = await f.inbox.atBoundary({ ...boundary, kind: 'idle' });
      if (!row.readable) assert.equal(idle.kind, 'successor_required', row.name);
      assert.deepEqual(f.store.getById(f.message.id).queueCustody.handledByCatIds, []);
    } finally {
      f.inbox.close();
      await f.app.close();
    }
  }
});

test('an earlier accepted notice cannot hide a later authoritative fallback to ordinary successor work', async () => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  try {
    assert.equal(
      (await f.inbox.atBoundary({ kind: 'tool_complete', generation: 1, userSpeaking: false })).kind,
      'accepted',
    );
    f.queue.fallbackAuthorIntentsForParentAcrossUsers('home', 'codex-astra', 'live-parent');
    await new QueuedMessageCustodyCoordinator({ messageStore: f.store }).persistEntry(
      f.queue.getEntrySnapshot('home', 'owner', f.entry.id),
    );
    const blockedRead = await f.read('&readIntent=unread');
    assert.equal(blockedRead.statusCode, 200);
    assert.equal(
      blockedRead.json().messages.some((message) => message.id === f.message.id),
      false,
    );
    const idle = await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false });
    assert.equal(idle.kind, 'successor_required');
    assert.equal(idle.successorSources[0].messageId, f.message.id);
    assert.equal(f.deliveries.length, 1, 'fallback must not manufacture another accepted notification');
    assert.equal(f.store.getById(f.message.id).queueCustody.bodyExposures, undefined);
  } finally {
    f.inbox.close();
    await f.app.close();
  }
});

test('historical exposure behind seen cursor only notifies when the current contiguous Queue path returns the body', async () => {
  const cases = [
    { name: 'old-child next-work', intent: { requested: 'next_work' }, previousChild: 'dead-child', readable: false },
    {
      name: 'same-child lost context',
      intent: { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
      previousChild: 'current',
      readable: false,
    },
    {
      name: 'old-child current-parent replay',
      intent: { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
      previousChild: 'dead-child',
      readable: true,
    },
    { name: 'published agent current Queue replay', source: 'agent', previousChild: 'dead-child', readable: true },
    {
      name: 'published history without current Queue carrier',
      source: 'agent',
      previousChild: 'dead-child',
      removeCarrier: true,
      readable: false,
    },
  ];
  for (const row of cases) {
    const f = await fixture(row.intent, row.source);
    try {
      const priorChild = row.previousChild === 'current' ? f.scope.invocationId : row.previousChild;
      f.queue.markQueuedSeen('home', 'owner', f.entry.id, 'codex-astra', priorChild);
      await new QueuedMessageCustodyCoordinator({ messageStore: f.store }).persistEntry(
        f.queue.getEntrySnapshot('home', 'owner', f.entry.id),
      );
      if (row.removeCarrier) {
        f.queue.markProcessing('home', 'owner');
        f.queue.removeProcessed('home', 'owner', f.entry.id);
      }
      const later = f.store.append({
        userId: 'owner',
        threadId: 'home',
        catId: 'opus',
        content: 'later published speech',
        mentions: [],
        timestamp: f.message.timestamp + 1,
      });
      const cursor = cursorFor({ id: later.id, visibilitySeq: f.store.getVisibilitySeq(later.id) });
      await f.cursorStore.ackSeenCursor('owner', 'codex-astra', 'home', cursor);

      if (!row.readable) {
        // Published history may be inspected without acquiring the pending
        // Queue work; the same child's already-exposed body remains an anchor.
        const custodyBefore = structuredClone(f.store.getById(f.message.id).queueCustody);
        const queueBefore = f.queue.getEntrySnapshot('home', 'owner', f.entry.id);
        const history = await f.read();
        assert.equal(history.statusCode, 200, row.name);
        assert.equal(
          history.json().messages.find((message) => message.id === f.message.id)?.content === 'actual queued body',
          row.previousChild !== 'current',
          row.name,
        );
        assert.deepEqual(f.store.getById(f.message.id).queueCustody, custodyBefore, row.name);
        assert.deepEqual(f.queue.getEntrySnapshot('home', 'owner', f.entry.id), queueBefore, row.name);
        assert.equal(await f.cursorStore.getSeenCursor('owner', 'codex-astra', 'home'), cursor, row.name);
        assert.equal(f.deliveries.length, 0, row.name);
      }

      const boundary = { kind: 'tool_complete', generation: 1, userSpeaking: false };
      const result = await f.inbox.atBoundary(boundary);
      const response = await f.read('&readIntent=unread');
      assert.equal(response.statusCode, 200, row.name);
      const returned = response.json().messages.find((message) => message.id === f.message.id);
      assert.equal(returned?.content === 'actual queued body', row.readable, row.name);
      assert.equal(response.json().hasMore, false, row.name);
      // Permission to inspect an old source is not proof of a contiguous replay/exposure path.
      const sparse = await f.read(`&messageId=${f.message.id}`);
      assert.equal(sparse.statusCode, 200, row.name);
      assert.equal(
        sparse.json().messages.find((message) => message.id === f.message.id)?.content,
        'actual queued body',
      );
      assert.equal(result.kind === 'accepted', row.readable, row.name);
      assert.equal(f.deliveries.length, row.readable ? 1 : 0, row.name);
      if (!row.readable) {
        const idle = await f.inbox.atBoundary({ ...boundary, kind: 'idle' });
        assert.equal(idle.kind, 'successor_required', row.name);
        assert.equal(idle.successorSources[0].messageId, f.message.id);
      }
      const exposures = f.store.getById(f.message.id).queueCustody.bodyExposures;
      assert.equal(
        exposures.some((exposure) => exposure.invocationId === f.scope.invocationId),
        row.readable || row.previousChild === 'current',
      );
      assert.deepEqual(f.store.getById(f.message.id).queueCustody.handledByCatIds, []);
      assert.equal(await f.cursorStore.getSeenCursor('owner', 'codex-astra', 'home'), cursor);
    } finally {
      f.inbox.close();
      await f.app.close();
    }
  }
});
