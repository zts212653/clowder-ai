import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CollectiveIngressDispatcher } from '../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { catAccepts, grantAndAdopt, postNaturalRequest } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

/** Real Service HTTP, Connector and Host ingress/Queue; no model executes and Host stores are in memory. */
async function setup() {
  const f = await fixture();
  const duty = createCatId('codex-terra');
  f.threads.addParticipants(f.endpoint.id, [duty]);
  await f.world.declareCats(f.cafe, [CAT, duty], { threadId: f.endpoint.id });
  const prior = await f.cafe.connector.getHostRoute(f.cafe.connectionId);
  assert.ok(prior);
  const configured = await f.cafe.connector.setHostRoute(
    f.cafe.connectionId,
    {
      localOwnerUserId: f.cafe.ownerUserId,
      defaultIngressThreadId: f.endpoint.id,
      humanNotificationThreadId: f.endpoint.id,
      agentRoutes: prior.agentRoutes,
      channelRoutes: {
        general: {
          channelId: 'general',
          threadId: f.endpoint.id,
          participants: { [CAT]: { displayName: 'Sol' }, [duty]: { displayName: 'Terra' } },
        },
      },
    },
    prior.revision,
  );
  await f.cafe.connector.publishParticipation(f.cafe.connectionId);
  const revision = configured.revision;
  const selected = new Set<string>();
  const unavailable = new Set<string>();
  const resumed: Array<{
    source: Awaited<ReturnType<typeof f.messages.getByIdempotencyKey>>;
    eventId: string;
    catId: string;
  }> = [];
  const wakeByComment = new Map<string, string>();
  const connector = f.cafe.connector;
  const ingress = new CollectiveIngressDispatcher({
    connector: {
      getProjection: (id) => connector.getProjection(id),
      getHostRoute: (id) => connector.getHostRoute(id),
      listInboxForRouting: async (id) =>
        (await connector.listInboxForRouting(id)).filter((item) => selected.has(item.event.eventId)),
      beginInboxRouting: (...args) => connector.beginInboxRouting(...args),
      completeInboxRouting: (...args) => connector.completeInboxRouting(...args),
      failInboxRouting: (...args) => connector.failInboxRouting(...args),
      readParticipationContext: (...args) => connector.readParticipationContext(...args),
      readWorkRoutingContext: (...args) => connector.readWorkRoutingContext(...args),
    },
    threadStore: f.threads,
    messageStore: f.messages,
    invocationQueue: f.queue,
    queueProcessor: { async processNext() {} },
    socketManager: { broadcastToRoom() {} },
    isCatAvailable: (cat) => !unavailable.has(cat),
    resumeWorkWake: async (source, event, catId) => {
      resumed.push({ source, eventId: event.eventId, catId });
    },
  });
  const message = async (body: string, replyToEventId?: string, expectedFailed = 0) => {
    const event = await f.world.store.postHumanMessage(f.world.wulang.sessionToken, {
      ...f.world.coordinates,
      clientEventId: `channel-${body}`,
      target: { kind: 'channel', channelId: 'general' },
      location: { channelId: 'general', ...(replyToEventId ? { rootEventId: f.work.sourceEventId } : {}) },
      recipient: { kind: 'channel' },
      ...(replyToEventId ? { replyToEventId } : {}),
      body,
    });
    selected.add(event.eventId);
    await connector.sync(f.cafe.connectionId);
    const wake = (await connector.listInboxForRouting(f.cafe.connectionId)).find(
      (item) => item.event.workWakeNotice?.reason === 'comment' && item.event.replyToEventId === event.eventId,
    );
    if (wake) {
      selected.add(wake.event.eventId);
      wakeByComment.set(event.eventId, wake.event.eventId);
    }
    const result = await ingress.dispatchConnection(f.cafe.connectionId);
    assert.equal(result.failed, expectedFailed);
    const stored = await f.messages.getByIdempotencyKey(
      f.cafe.ownerUserId,
      f.endpoint.id,
      `collective-ingress:${event.serviceInstanceId}:${event.collectiveId}:${event.eventId}`,
    );
    assert.ok(stored);
    return stored;
  };
  const listen = async (mode: 'mentions' | 'all') => {
    const route = await connector.getHostRoute(f.cafe.connectionId);
    assert.ok(route);
    return connector.setChannelListening(
      f.cafe.connectionId,
      f.cafe.ownerUserId,
      mode === 'all'
        ? { channelId: 'general', mode, dutyCatId: duty, expectedAttentionRevision: route.attentionRevision }
        : { channelId: 'general', mode, expectedAttentionRevision: route.attentionRevision },
    );
  };
  return { ...f, duty, revision, ingress, message, listen, resumed, unavailable, wakeByComment };
}

test('mentions-only persists ordinary conversation; all queues exactly the configured duty Cat as public classification', async () => {
  const f = await setup();
  try {
    const before = await f.cafe.connector.getHostRoute(f.cafe.connectionId);
    const quiet = await f.message('Ordinary channel conversation');
    assert.equal(quiet.queueCustody, undefined);
    assert.equal(f.queue.list(f.endpoint.id, f.cafe.ownerUserId).length, 0);
    await f.listen('all');
    const active = await f.message('A new idea in the shared channel');
    assert.deepEqual(active.extra?.targetCats, [f.duty]);
    const activeEntry = f.queue
      .list(f.endpoint.id, f.cafe.ownerUserId)
      .find((entry) => entry.payload.messageId === active.id);
    assert.equal(activeEntry?.execution?.executionScope, 'collective-participation');
    assert.equal(activeEntry?.execution?.ownerAuthProvenance, 'unknown');
    assert.equal(
      active.source?.meta?.attentionRequest,
      undefined,
      'listening does not forge an explicit response request',
    );
    assert.equal(f.queue.list(f.endpoint.id, f.cafe.ownerUserId).length, 1);
    assert.equal((await f.tasks.listByKind('work')).length, 1, 'classification does not commit or admit another Work');
    assert.equal(
      (await f.cafe.connector.getHostRoute(f.cafe.connectionId))?.revision,
      before?.revision,
      'attention does not change participation authority',
    );
  } finally {
    await f.world.close();
  }
});

test('precise A feedback selects its assigned Cat despite a newer B or another duty Cat, including mentions-only mode', async () => {
  const f = await setup();
  try {
    await grantAndAdopt(f.world, f.cafe, {
      grants: [
        {
          grantRef: 'grant-guides',
          catIds: [CAT],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['guide'],
          expiresAt: null,
        },
        {
          grantRef: 'terra-guides',
          catIds: [f.duty],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['guide'],
          expiresAt: null,
        },
      ],
    });
    const requestB = await postNaturalRequest(
      f.world,
      f.world.wulang,
      f.cafe,
      f.duty,
      'Matter B is newer and belongs to Terra',
      f.revision,
    );
    await catAccepts(f.world, f.cafe, requestB, { grantRef: 'terra-guides', grantRevision: 1, title: 'Matter B' });
    await f.listen('all');
    const first = await f.message('Feedback on A while Terra is on duty', f.work.assignmentEventId);
    assert.equal(first.extra?.targetCats, undefined, 'the public comment remains visible without a second queue entry');
    await f.listen('mentions');
    const second = await f.message('More A feedback without any mention', f.work.assignmentEventId);
    assert.equal(
      second.extra?.targetCats,
      undefined,
      'the typed wake reuses the visible comment for the original Task',
    );
    assert.equal(second.source?.meta?.attentionRequest, undefined);
    assert.deepEqual(
      f.resumed.map(({ source, catId }) => ({ messageId: source?.id, catId })),
      [
        { messageId: first.id, catId: CAT },
        { messageId: second.id, catId: CAT },
      ],
    );
    assert.equal(
      f.queue.list(f.endpoint.id, f.cafe.ownerUserId).some((entry) => entry.payload.messageId === second.id),
      false,
      'an exact Work comment resumes the existing private Task instead of creating public participation work',
    );
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

test('unavailable duty and feedback Cats preserve channel delivery and durable attention failure', async () => {
  const f = await setup();
  try {
    await f.listen('all');
    f.unavailable.add(f.duty);
    const ordinary = await f.message('Duty Cat is offline');
    assert.equal(ordinary.queueCustody, undefined);
    const inbox = (await f.cafe.connector.listInbox(f.cafe.connectionId)).find(
      (item) => item.routeReceipt?.kind === 'thread_message' && item.routeReceipt.messageId === ordinary.id,
    );
    assert.equal(inbox?.routeReceipt?.kind, 'thread_message');
    if (inbox?.routeReceipt?.kind === 'thread_message')
      assert.deepEqual(inbox.routeReceipt.attention, {
        request: 'channel_listening',
        state: 'failed',
        reason: 'ROUTE_CAT_UNAVAILABLE',
      });
    f.unavailable.add(CAT);
    const feedback = await f.message('Actual Work feedback while its Cat is offline', f.work.assignmentEventId, 1);
    assert.equal(feedback.queueCustody, undefined);
    assert.deepEqual(f.resumed, []);
    assert.equal(f.queue.list(f.endpoint.id, f.cafe.ownerUserId).length, 0);
    const commentEventId = feedback.source?.meta?.eventId;
    const wakeEventId = commentEventId ? f.wakeByComment.get(commentEventId) : undefined;
    assert.ok(wakeEventId);
    const failedWake = (await f.cafe.connector.listInbox(f.cafe.connectionId)).find(
      (item) => item.event.eventId === wakeEventId,
    );
    assert.equal(failedWake?.disposition, 'route_failed');
    assert.equal(failedWake?.routeFailure?.code, 'ROUTE_CAT_UNAVAILABLE');

    f.unavailable.delete(CAT);
    assert.deepEqual(await f.ingress.dispatchConnection(f.cafe.connectionId), { routed: 1, failed: 0, skipped: 0 });
    assert.deepEqual(
      f.resumed.map(({ catId }) => catId),
      [CAT],
    );
    const recoveredWake = (await f.cafe.connector.listInbox(f.cafe.connectionId)).find(
      (item) => item.event.eventId === wakeEventId,
    );
    assert.equal(recoveredWake?.disposition, 'routed');
    assert.equal(recoveredWake?.routeReceipt?.kind, 'thread_message');
    if (recoveredWake?.routeReceipt?.kind === 'thread_message') {
      assert.equal(recoveredWake.routeReceipt.messageId, feedback.id);
    }
  } finally {
    await f.world.close();
  }
});

test('participation edits clear a removed duty Cat without changing another active listener', async () => {
  const f = await setup();
  try {
    await f.listen('all');
    const prior = await f.cafe.connector.getHostRoute(f.cafe.connectionId);
    assert.ok(prior);
    const updated = await f.cafe.connector.setHostRoute(
      f.cafe.connectionId,
      {
        localOwnerUserId: prior.localOwnerUserId,
        defaultIngressThreadId: prior.defaultIngressThreadId,
        humanNotificationThreadId: prior.humanNotificationThreadId,
        agentRoutes: prior.agentRoutes,
        channelRoutes: { general: { ...prior.channelRoutes.general, participants: { [CAT]: { displayName: 'Sol' } } } },
      },
      prior.revision,
    );
    assert.equal(updated.channelListening?.general, undefined);
    assert.equal(updated.attentionRevision, prior.attentionRevision + 1);
    assert.ok(updated.channelRoutes.general.participants[CAT]);
  } finally {
    await f.world.close();
  }
});
