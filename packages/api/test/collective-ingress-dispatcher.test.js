import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CollectiveIngressDispatcher } from '../dist/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';

function event(overrides = {}) {
  const target = overrides.target ?? { kind: 'channel', channelId: 'general' };
  return {
    eventId: 'evt_100000000000',
    serviceInstanceId: 'svc_100000000000',
    collectiveId: 'col_100000000000',
    sequence: 1,
    actor: { kind: 'human', humanId: 'human_owner00000', displayName: 'You' },
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient:
      target.kind === 'agent'
        ? { ...target, connectionId: 'con_100000000000', participationRevision: 1 }
        : target.kind === 'human'
          ? target
          : { kind: 'channel' },
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
    connectionId: 'con_100000000000',
    localOwnerUserId: 'owner_1',
    defaultIngressThreadId: 'thread_channel',
    humanNotificationThreadId: 'thread_human',
    agentRoutes: {
      'human_owner00000:codex-sol': {
        catId: 'codex-sol',
        threadId: 'thread_agent',
        participation: { displayName: 'Sol', channelIds: ['general'] },
      },
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
  const revisions = [];
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
  for (const endpoint of Object.values(route.channelRoutes ?? {})) {
    threads.set(endpoint.threadId, {
      id: endpoint.threadId,
      createdBy: 'owner_1',
      deletedAt: null,
      participants: Object.keys(endpoint.participants),
    });
  }
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
    readParticipationContext: async () => ({}),
    getProjection: async () => ({
      connectionId: 'con_100000000000',
      serviceInstanceId: 'svc_100000000000',
      collectiveId: 'col_100000000000',
      authorizedHumanId: 'human_owner00000',
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
    resumeWorkRevision: async (source, revisionEvent, catId) => {
      revisions.push({ source, event: revisionEvent, catId });
    },
    isCatAvailable: (catId) => !(options.unavailableCats ?? []).includes(catId),
    now: () => Date.parse('2026-08-29T18:01:00.000Z'),
  });
  return { dispatcher, connector, inbox, completions, failures, messages, queue, broadcasts, processed, revisions };
}

test('routes default Channel ingress idempotently and keeps route receipt separate from Service ACK', async () => {
  const h = harness([event()]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal([...h.messages.values()][0].threadId, 'thread_channel');
  assert.equal([...h.messages.values()][0].source.meta.eventId, 'evt_100000000000');
  assert.equal(h.broadcasts[0].name, 'connector_message');
  assert.equal(h.completions[0].receipt.threadId, 'thread_channel');

  h.inbox[0].disposition = 'routing';
  h.completions.length = 0;
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.completions[0].receipt.messageId, 'msg_1');
});

test('routes each Channel and every named Cat through the shared Café×Channel endpoint', async () => {
  const channelRoutes = {
    general: {
      channelId: 'general',
      threadId: 'thread_general_endpoint',
      participants: { 'codex-sol': { displayName: 'Sol' }, 'codex-terra': { displayName: 'Terra' } },
    },
    second: {
      channelId: 'second',
      threadId: 'thread_second_endpoint',
      participants: { 'codex-sol': { displayName: 'Sol' } },
    },
  };
  const h = harness(
    [
      event({ eventId: 'evt_general_channel', sequence: 1 }),
      event({
        eventId: 'evt_second_channel0',
        sequence: 2,
        target: { kind: 'channel', channelId: 'second' },
        location: { channelId: 'second' },
        recipient: { kind: 'channel' },
      }),
      event({
        eventId: 'evt_general_agent0',
        sequence: 3,
        target: { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' },
      }),
    ],
    { route: { agentRoutes: {}, channelRoutes } },
  );

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 3,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(
    [...h.messages.values()].map((message) => message.threadId),
    ['thread_general_endpoint', 'thread_second_endpoint', 'thread_general_endpoint'],
  );
  assert.equal(h.queue[0].threadId, 'thread_general_endpoint');
  assert.deepEqual(h.queue[0].targetCats, ['codex-sol']);
});

test('routes revision feedback into the same private Work without a duplicate public invocation', async () => {
  const revision = event({
    eventId: 'evt_revision00000',
    clientEventId: 'work-revision:work_aaaaaaaa:request-v2',
    target: { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' },
    workRequest: 'revise',
    workRevisionNotice: {
      v: 1,
      workId: 'work_aaaaaaaa',
      workRevision: 4,
      assignmentEventId: 'evt_assignment00',
      resultEventId: 'evt_result000000',
      resultRevision: 1,
    },
    body: '请补上重启后的恢复证据。',
  });
  const h = harness([revision]);

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(h.queue.length, 0, 'revision feedback must not also launch a public-participation turn');
  assert.equal(h.revisions.length, 1);
  assert.equal(h.revisions[0].catId, 'codex-sol');
  assert.equal(h.revisions[0].event.workRevisionNotice.resultRevision, 1);
  assert.equal(h.revisions[0].source.source.meta.workRequest, 'revise');
  assert.deepEqual(h.revisions[0].source.source.meta.workRevisionNotice, revision.workRevisionNotice);
  assert.equal(h.completions[0].receipt.messageId, h.revisions[0].source.id);
});

test('wakes at most one self-subscribed Cat for an explicit response request and leaves ordinary talk quiet', async () => {
  const channelRoutes = {
    general: {
      channelId: 'general',
      threadId: 'thread_general_endpoint',
      participants: { 'codex-sol': { displayName: 'Sol' }, 'codex-terra': { displayName: 'Terra' } },
    },
  };
  const standingInterests = {
    general: {
      'codex-sol': {
        catId: 'codex-sol',
        kind: 'response_requests',
        status: 'active',
        revision: 1,
        updatedAt: '2026-09-11T00:00:00.000Z',
      },
      'codex-terra': {
        catId: 'codex-terra',
        kind: 'response_requests',
        status: 'active',
        revision: 2,
        updatedAt: '2026-09-11T00:01:00.000Z',
      },
    },
  };
  const requested = harness([event({ eventId: 'evt_response_request', attentionRequest: 'response_requested' })], {
    route: { agentRoutes: {}, channelRoutes, standingInterests, attentionRevision: 2 },
  });
  assert.deepEqual(await requested.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(requested.queue.length, 1);
  assert.deepEqual(requested.queue[0].targetCats, ['codex-sol']);
  assert.equal(requested.queue[0].threadId, 'thread_general_endpoint');
  assert.equal([...requested.messages.values()][0].source.meta.participation.catId, 'codex-sol');
  assert.deepEqual(requested.completions[0].receipt.attention, {
    request: 'response_requested',
    state: 'wake_queued',
    catId: 'codex-sol',
    interestRevision: 1,
  });

  const ordinary = harness([event({ eventId: 'evt_ordinary_talk' })], {
    route: { agentRoutes: {}, channelRoutes, standingInterests, attentionRevision: 2 },
  });
  assert.deepEqual(await ordinary.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(ordinary.queue.length, 0);
  assert.equal(ordinary.completions[0].receipt.attention, undefined);
});

test('persists an explicit response request as delivered but unclaimed when no Cat declared interest', async () => {
  const h = harness([event({ eventId: 'evt_unclaimed_request', attentionRequest: 'response_requested' })], {
    route: {
      agentRoutes: {},
      channelRoutes: {
        general: {
          channelId: 'general',
          threadId: 'thread_general_endpoint',
          participants: { 'codex-sol': { displayName: 'Sol' } },
        },
      },
      standingInterests: {},
      attentionRevision: 0,
    },
  });
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(h.messages.size, 1);
  assert.equal(h.queue.length, 0);
  assert.deepEqual(h.completions[0].receipt.attention, {
    request: 'response_requested',
    state: 'unclaimed',
  });
});

test('recovers a crash after Host append without waiting for a route edit or duplicating the message', async () => {
  const h = harness([event({ eventId: 'evt_crash_window' })], { failCompletionOnce: true });

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 0, failed: 1, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.inbox[0].disposition, 'routing');
  assert.equal(h.failures.length, 0);

  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.messages.size, 1);
  assert.equal(h.inbox[0].disposition, 'routed');
  assert.equal(h.completions[0].receipt.messageId, 'msg_1');
});

test('keeps concurrent drains idempotent at the Host effect boundary', async () => {
  const h = harness([event({ eventId: 'evt_concurrent00' })]);

  const results = await Promise.all([
    h.dispatcher.dispatchConnection('con_100000000000'),
    h.dispatcher.dispatchConnection('con_100000000000'),
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
      eventId: 'evt_agent0000000',
      target: { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' },
    }),
  ]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 1, failed: 0, skipped: 0 });
  assert.equal(h.queue.length, 1);
  assert.equal(h.queue[0].ownerAuthProvenance, 'unknown');
  assert.deepEqual(h.queue[0].targetCats, ['codex-sol']);
  assert.equal(h.queue[0].threadId, 'thread_agent');
  assert.equal([...h.messages.values()][0].deliveryStatus, 'queued');
  assert.deepEqual(h.processed, [{ threadId: 'thread_agent', ownerId: 'owner_1' }]);
  assert.equal(h.completions[0].receipt.catId, 'codex-sol');
});

test('skips explicit targets for another Human without falling back or inventing a repair failure', async () => {
  const wrongHuman = harness([
    event({ eventId: 'evt_other_human0', target: { kind: 'human', humanId: 'human_other00000' } }),
  ]);
  assert.deepEqual(await wrongHuman.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 0,
    skipped: 1,
  });
  assert.equal(wrongHuman.messages.size, 0);
  assert.deepEqual(wrongHuman.completions[0].receipt, { kind: 'not_local' });
  assert.equal(wrongHuman.failures.length, 0);

  const wrongHumanAgent = harness([
    event({
      eventId: 'evt_other_human_agent',
      target: { kind: 'agent', humanId: 'human_other00000', agentId: 'remote-agent' },
    }),
  ]);
  assert.deepEqual(await wrongHumanAgent.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 0,
    skipped: 1,
  });
  assert.deepEqual(wrongHumanAgent.completions[0].receipt, { kind: 'not_local' });
  assert.equal(wrongHumanAgent.queue.length, 0);
});

test('fails a local explicit Agent target closed when its configured Cat is unavailable', async () => {
  const unavailableAgent = harness(
    [
      event({
        eventId: 'evt_offline_agent',
        target: { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' },
      }),
    ],
    { unavailableCats: ['codex-sol'] },
  );
  assert.deepEqual(await unavailableAgent.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(unavailableAgent.messages.size, 0);
  assert.equal(unavailableAgent.failures[0].failure.code, 'ROUTE_CAT_UNAVAILABLE');
});

test('fails every invalid local Agent route closed without falling back to a Channel', async () => {
  const target = { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' };
  const unconfigured = harness([event({ eventId: 'evt_unconfigured_agent', target })], {
    route: { agentRoutes: {} },
  });
  assert.deepEqual(await unconfigured.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(unconfigured.failures[0].failure.code, 'ROUTE_AGENT_UNCONFIGURED');
  assert.equal(unconfigured.messages.size, 0);

  const catNotInThread = harness([event({ eventId: 'evt_cat_not_in_thread', target })], {
    route: {
      agentRoutes: {
        'human_owner00000:codex-sol': {
          catId: 'codex-sol',
          threadId: 'thread_channel',
          participation: { displayName: 'Sol', channelIds: ['general'] },
        },
      },
    },
  });
  assert.deepEqual(await catNotInThread.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(catNotInThread.failures[0].failure.code, 'ROUTE_CAT_NOT_IN_THREAD');
  assert.equal(catNotInThread.queue.length, 0);

  const queueFull = harness([event({ eventId: 'evt_queue_full00', target })], { queueFullOnce: true });
  assert.deepEqual(await queueFull.dispatcher.dispatchConnection('con_100000000000'), {
    routed: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(queueFull.failures[0].failure.code, 'ROUTE_QUEUE_FULL');
  assert.equal(queueFull.messages.size, 0);
});

test('legacy or revoked participation never wakes a Cat, and another endpoint is not a same-name fallback', async () => {
  const target = { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' };
  for (const overrides of [
    { location: undefined, recipient: undefined },
    { recipient: { ...target, connectionId: 'con_100000000000', participationRevision: 2 } },
    { location: { channelId: 'private' } },
  ]) {
    const h = harness([event({ target, ...overrides })]);
    await h.dispatcher.dispatchConnection('con_100000000000');
    assert.equal(h.queue.length, 0);
    assert.equal(h.failures[0].failure.code, 'PARTICIPATION_REVOKED');
  }
  const h = harness([
    event({ target, recipient: { ...target, connectionId: 'con_other0000000', participationRevision: 1 } }),
  ]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 0, failed: 0, skipped: 1 });
  assert.equal(h.queue.length, 0);
});

test('fails missing, deleted, and foreign-owner ingress Threads closed', async () => {
  for (const [label, options] of [
    ['missing', { missingThreads: ['thread_channel'] }],
    ['deleted', { deletedThreads: ['thread_channel'] }],
    ['foreign', { foreignThreads: ['thread_channel'] }],
  ]) {
    const h = harness([event({ eventId: `evt_${label}_thread` })], options);
    assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), {
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
      eventId: 'evt_echo00000000',
      actor: {
        kind: 'agent',
        human: { humanId: 'human_owner00000', displayName: 'You' },
        agent: { agentId: 'codex-sol', displayName: 'Sol' },
        provenance: { connectionId: 'con_100000000000', catId: 'codex-sol', sessionRef: 'inv_1' },
      },
      target: { kind: 'channel', channelId: 'general' },
    }),
  ]);
  assert.deepEqual(await h.dispatcher.dispatchConnection('con_100000000000'), { routed: 0, failed: 0, skipped: 1 });
  assert.equal(h.messages.size, 0);
  assert.deepEqual(h.completions[0].receipt, { kind: 'local_echo' });
});
