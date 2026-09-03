import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CollectiveIngressDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';

function event(overrides = {}) {
  return {
    eventId: 'evt_1',
    serviceInstanceId: 'svc_1',
    collectiveId: 'col_1',
    sequence: 1,
    actor: { kind: 'human', humanId: 'human_owner', displayName: 'You' },
    target: { kind: 'channel', channelId: 'general' },
    body: 'A real Collective message.',
    acceptedAt: '2026-08-29T18:00:00.000Z',
    ...overrides,
  };
}

function harness(events, options = {}) {
  const inbox = events.map((item) => ({
    event: item,
    disposition: 'persisted',
    persistedAt: '2026-08-29T18:00:01.000Z',
  }));
  const route = {
    connectionId: 'con_1',
    localOwnerUserId: 'owner_1',
    defaultIngressThreadId: 'thread_channel',
    humanNotificationThreadId: 'thread_human',
    agentRoutes: {
      'human_owner:codex-sol': { catId: 'codex-sol', threadId: 'thread_agent' },
    },
    revision: 1,
    updatedAt: '2026-08-29T18:00:00.000Z',
    ...options.route,
  };
  const completions = [];
  const failures = [];
  const messages = new Map();
  const queue = [];
  const broadcasts = [];
  const processed = [];
  let completionAttempts = 0;
  const threads = new Map(
    ['thread_channel', 'thread_human', 'thread_agent'].map((threadId) => [
      threadId,
      {
        id: threadId,
        createdBy: 'owner_1',
        deletedAt: null,
        participants: threadId === 'thread_agent' ? ['codex-sol'] : [],
      },
    ]),
  );
  for (const missing of options.missingThreads ?? []) threads.delete(missing);
  for (const deleted of options.deletedThreads ?? []) {
    const thread = threads.get(deleted);
    if (thread) thread.deletedAt = '2026-08-29T18:00:30.000Z';
  }
  for (const foreign of options.foreignThreads ?? []) {
    const thread = threads.get(foreign);
    if (thread) thread.createdBy = 'another_owner';
  }
  let queueFullRemaining = options.queueFullOnce ? 1 : 0;
  const connector = {
    getProjection: async () => ({
      connectionId: 'con_1',
      serviceInstanceId: 'svc_1',
      collectiveId: 'col_1',
      authorizedHumanId: 'human_owner',
      authorityStatus: 'connected',
    }),
    getHostRoute: async () => route,
    listInboxForRouting: async () => inbox.filter((item) => item.disposition !== 'routed'),
    beginInboxRouting: async (_connectionId, eventId, revision) => {
      const item = inbox.find((candidate) => candidate.event.eventId === eventId);
      item.disposition = 'routing';
      item.routeConfigRevision = revision;
      return structuredClone(item);
    },
    completeInboxRouting: async (_connectionId, eventId, revision, receipt) => {
      completionAttempts += 1;
      if (options.failCompletionOnce && completionAttempts === 1) {
        throw new Error('simulated crash before disposition commit');
      }
      const item = inbox.find((candidate) => candidate.event.eventId === eventId);
      item.disposition = 'routed';
      item.routeConfigRevision = revision;
      item.routeReceipt = receipt;
      completions.push({ eventId, receipt });
      return structuredClone(item);
    },
    failInboxRouting: async (_connectionId, eventId, revision, failure) => {
      const item = inbox.find((candidate) => candidate.event.eventId === eventId);
      item.disposition = 'route_failed';
      item.routeConfigRevision = revision;
      item.routeFailure = failure;
      failures.push({ eventId, failure });
      return structuredClone(item);
    },
  };
  let messageNumber = 0;
  const dispatcher = new CollectiveIngressDispatcher({
    connector,
    threadStore: { get: async (threadId) => threads.get(threadId) ?? null },
    messageStore: {
      appendIdempotent: async (input) => {
        const key = `${input.userId}:${input.threadId}:${input.idempotencyKey}`;
        const existing = messages.get(key);
        if (existing) return { message: existing, idempotent: true };
        const stored = { ...input, id: `msg_${++messageNumber}`, threadId: input.threadId };
        messages.set(key, stored);
        return { message: stored, idempotent: false };
      },
    },
    invocationQueue: {
      enqueue: (input) => {
        if (queueFullRemaining > 0) {
          queueFullRemaining -= 1;
          return { outcome: 'full' };
        }
        const existing = queue.find((entry) => entry.idempotencyKey === input.idempotencyKey);
        if (existing) return { outcome: 'enqueued', entry: existing, deduped: true };
        const entry = {
          ...input,
          id: `queue_${queue.length + 1}`,
          messageId: null,
          mergedMessageIds: [],
          status: 'queued',
          createdAt: Date.now(),
          autoExecute: true,
          priority: 'normal',
        };
        queue.push(entry);
        return { outcome: 'enqueued', entry, deduped: false };
      },
      backfillMessageId: (_threadId, _ownerId, entryId, messageId) => {
        queue.find((entry) => entry.id === entryId).messageId = messageId;
      },
      rollbackEnqueue: (_threadId, _ownerId, entryId) => {
        const index = queue.findIndex((entry) => entry.id === entryId);
        if (index >= 0) queue.splice(index, 1);
      },
    },
    queueProcessor: { processNext: async (threadId, ownerId) => processed.push({ threadId, ownerId }) },
    socketManager: { broadcastToRoom: (room, name, payload) => broadcasts.push({ room, name, payload }) },
    isCatAvailable: (catId) => !(options.unavailableCats ?? []).includes(catId),
    now: () => Date.parse('2026-08-29T18:01:00.000Z'),
  });
  return { dispatcher, connector, inbox, completions, failures, messages, queue, broadcasts, processed };
}

test('routes default Channel ingress idempotently and keeps route receipt separate from Service ACK', async () => {
  const h = harness([event()]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal([...h.messages.values()][0].threadId, 'thread_channel');
  assert.equal([...h.messages.values()][0].source.meta.eventId, 'evt_1');
  assert.equal(h.broadcasts[0].name, 'connector_message');
  assert.equal(h.completions[0].receipt.threadId, 'thread_channel');

  h.inbox[0].disposition = 'routing';
  h.completions.length = 0;
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.completions[0].receipt.messageId, 'msg_1');
});

test('recovers a crash after Host append without waiting for a route edit or duplicating the message', async () => {
  const h = harness([event({ eventId: 'evt_crash_window' })], { failCompletionOnce: true });

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 0, failed: 1, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.inbox[0].disposition, 'routing');
  assert.equal(h.failures.length, 0);

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.inbox[0].disposition, 'routed');
  assert.equal(h.completions[0].receipt.messageId, 'msg_1');
});

test('keeps concurrent drains idempotent at the Host effect boundary', async () => {
  const h = harness([event({ eventId: 'evt_concurrent' })]);

  const results = await Promise.all([
    h.dispatcher.dispatchConnection('con_1'),
    h.dispatcher.dispatchConnection('con_1'),
  ]);

  assert.equal(h.messages.size, 1);
  assert.equal(h.inbox[0].disposition, 'routed');
  assert.equal(
    results.reduce((count, result) => count + result.routed, 0),
    2,
  );
  assert.ok(h.completions.every((completion) => completion.receipt.messageId === 'msg_1'));
});

test('routes an explicit Agent target only to its configured live Cat and Thread', async () => {
  const h = harness([
    event({
      eventId: 'evt_agent',
      target: { kind: 'agent', humanId: 'human_owner', agentId: 'codex-sol' },
    }),
  ]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.queue.length, 1);
  assert.deepEqual(h.queue[0].targetCats, ['codex-sol']);
  assert.equal(h.queue[0].threadId, 'thread_agent');
  assert.equal([...h.messages.values()][0].deliveryStatus, 'queued');
  assert.deepEqual(h.processed, [{ threadId: 'thread_agent', ownerId: 'owner_1' }]);
  assert.equal(h.completions[0].receipt.catId, 'codex-sol');
});

test('skips explicit targets for another Human without falling back or inventing a repair failure', async () => {
  const wrongHuman = harness([
    event({ eventId: 'evt_other_human', target: { kind: 'human', humanId: 'human_other' } }),
  ]);
  assert.deepEqual(await wrongHuman.dispatcher.dispatchConnection('con_1'), { routed: 0, failed: 0, skipped: 1 });
  assert.equal(wrongHuman.messages.size, 0);
  assert.deepEqual(wrongHuman.completions[0].receipt, { kind: 'not_local' });
  assert.equal(wrongHuman.failures.length, 0);

  const wrongHumanAgent = harness([
    event({
      eventId: 'evt_other_human_agent',
      target: { kind: 'agent', humanId: 'human_other', agentId: 'remote-agent' },
    }),
  ]);
  assert.deepEqual(await wrongHumanAgent.dispatcher.dispatchConnection('con_1'), {
    routed: 0,
    failed: 0,
    skipped: 1,
  });
  assert.deepEqual(wrongHumanAgent.completions[0].receipt, { kind: 'not_local' });
  assert.equal(wrongHumanAgent.queue.length, 0);
});

test('fails a local explicit Agent target closed when its configured Cat is unavailable', async () => {
  const unavailableAgent = harness(
    [event({ eventId: 'evt_offline_agent', target: { kind: 'agent', humanId: 'human_owner', agentId: 'codex-sol' } })],
    { unavailableCats: ['codex-sol'] },
  );
  assert.deepEqual(await unavailableAgent.dispatcher.dispatchConnection('con_1'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(unavailableAgent.messages.size, 0);
  assert.equal(unavailableAgent.failures[0].failure.code, 'ROUTE_CAT_UNAVAILABLE');
});

test('fails every invalid local Agent route closed without falling back to a Channel', async () => {
  const target = { kind: 'agent', humanId: 'human_owner', agentId: 'codex-sol' };
  const unconfigured = harness([event({ eventId: 'evt_unconfigured_agent', target })], {
    route: { agentRoutes: {} },
  });
  assert.deepEqual(await unconfigured.dispatcher.dispatchConnection('con_1'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(unconfigured.failures[0].failure.code, 'ROUTE_AGENT_UNCONFIGURED');
  assert.equal(unconfigured.messages.size, 0);

  const catNotInThread = harness([event({ eventId: 'evt_cat_not_in_thread', target })], {
    route: {
      agentRoutes: { 'human_owner:codex-sol': { catId: 'codex-sol', threadId: 'thread_channel' } },
    },
  });
  assert.deepEqual(await catNotInThread.dispatcher.dispatchConnection('con_1'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(catNotInThread.failures[0].failure.code, 'ROUTE_CAT_NOT_IN_THREAD');
  assert.equal(catNotInThread.queue.length, 0);

  const queueFull = harness([event({ eventId: 'evt_queue_full', target })], { queueFullOnce: true });
  assert.deepEqual(await queueFull.dispatcher.dispatchConnection('con_1'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(queueFull.failures[0].failure.code, 'ROUTE_QUEUE_FULL');
  assert.equal(queueFull.messages.size, 0);
});

test('fails missing, deleted, and foreign-owner ingress Threads closed', async () => {
  for (const [label, options] of [
    ['missing', { missingThreads: ['thread_channel'] }],
    ['deleted', { deletedThreads: ['thread_channel'] }],
    ['foreign', { foreignThreads: ['thread_channel'] }],
  ]) {
    const h = harness([event({ eventId: `evt_${label}_thread` })], options);
    assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), {
      routed: 0,
      failed: 1,
      skipped: 0,
    });
    assert.equal(h.failures[0].failure.code, 'ROUTE_THREAD_UNAVAILABLE');
    assert.equal(h.messages.size, 0);
  }
});

test('marks locally-originated Agent events as routed echoes without reinvoking the Cat', async () => {
  const h = harness([
    event({
      eventId: 'evt_echo',
      actor: {
        kind: 'agent',
        human: { humanId: 'human_owner', displayName: 'You' },
        agent: { agentId: 'codex-sol', displayName: 'Sol' },
        provenance: { connectionId: 'con_1', catId: 'codex-sol', sessionRef: 'inv_1' },
      },
      target: { kind: 'channel', channelId: 'general' },
    }),
  ]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_1'), { routed: 0, failed: 0, skipped: 1 });
  assert.equal(h.messages.size, 0);
  assert.deepEqual(h.completions[0].receipt, { kind: 'local_echo' });
});
