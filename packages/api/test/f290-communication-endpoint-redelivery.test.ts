/** Real disk-backed Service/Connector and production routing; Host stores and queue processor are fixtures, no model. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { CollectiveIngressDispatcher } from '../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { reconcileParticipation } from '../src/domains/plugin/builtin-runtime/collective-participation-reconciler.js';
import { collectiveOwnerParticipationView } from '../src/routes/collective-owner-participation-view.js';
import { createWorld, postNaturalRequest, type World } from './f290-communication-validation.harness.js';

const cats = [{ id: 'codex-sol', displayName: 'Sol', supported: true }];
const emptyDispatch = { routed: 0, failed: 0, skipped: 0 };

async function brokenEndpoint(world: World) {
  const cafe = world.operator;
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const processed: { threadId: string; userId: string }[] = [];
  const dispatcher = new CollectiveIngressDispatcher({
    connector: cafe.connector,
    threadStore: threads,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: {
      async processNext(threadId, userId) {
        processed.push({ threadId, userId });
        return { started: false }; // Recording fixture, never starts a model.
      },
    },
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
    isCatAvailable: () => true,
  });
  const reconcile = async (policy?: Parameters<typeof reconcileParticipation>[0]['policy']) => {
    const route = await cafe.connector.getHostRoute(cafe.connectionId);
    return reconcileParticipation({
      connector: cafe.connector,
      threads,
      cats,
      ownerUserId: cafe.ownerUserId,
      connectionId: cafe.connectionId,
      route,
      expectedRevision: route?.revision ?? 0,
      channelIds: ['general'],
      policy,
    });
  };
  const view = async () =>
    collectiveOwnerParticipationView(
      { cats: () => cats, threads, messages, tasks: { listByKind: async () => [] } },
      {
        connector: cafe.connector,
        connection: await cafe.connector.getProjection(cafe.connectionId),
        route: await cafe.connector.getHostRoute(cafe.connectionId),
        userId: cafe.ownerUserId,
      },
    );
  // Nonempty legacy agent routes must remain inert once channel routes exist.
  const legacy = threads.create(cafe.ownerUserId, 'Legacy agent endpoint');
  await world.declareCats(cafe, ['codex-sol'], { threadId: legacy.id });
  const originalRoute = await reconcile();
  await world.syncAll();
  const event = await postNaturalRequest(
    world,
    world.wulang,
    cafe,
    'codex-sol',
    'Old mention sent before repair',
    originalRoute.revision,
  );
  await world.syncAll();
  const inboxItem = async () => {
    const items = await cafe.connector.listInbox(cafe.connectionId);
    assert.equal(items.filter((item) => item.event.eventId === event.eventId).length, 1);
    const item = items.find((candidate) => candidate.event.eventId === event.eventId);
    assert.ok(item);
    return item;
  };
  const oldThreadId = originalRoute.channelRoutes.general.threadId;
  threads.delete(oldThreadId);
  assert.deepEqual(await dispatcher.dispatchConnection(cafe.connectionId), { ...emptyDispatch, failed: 1 });
  const failed = await inboxItem();
  assert.equal(failed.disposition, 'route_failed');
  assert.equal(failed.routeFailure?.code, 'ROUTE_THREAD_UNAVAILABLE');
  assert.equal(failed.routeConfigRevision, originalRoute.revision);
  assert.equal((await view()).reconcileRequired, true);
  assert.equal(
    (await view()).requests.find((request) => request.event.eventId === event.eventId)?.failure?.code,
    'ROUTE_THREAD_UNAVAILABLE',
  );
  assert.deepEqual(processed, []);
  assert.deepEqual(messages.getByThreadIncludingQueued(legacy.id, 50, cafe.ownerUserId), []);
  return {
    cafe,
    threads,
    messages,
    queue,
    processed,
    dispatcher,
    reconcile,
    view,
    originalRoute,
    event,
    inboxItem,
    oldThreadId,
  };
}

test('endpoint repair redelivers the same failed mention once, retaining scope and legacy agent routes', async () => {
  const world = await createWorld();
  try {
    const host = await brokenEndpoint(world);
    assert.deepEqual(
      await host.dispatcher.dispatchConnection(host.cafe.connectionId),
      emptyDispatch,
      'an unchanged route does not retry the unavailable Thread',
    );
    const repaired = await host.reconcile();
    const threadId = repaired.channelRoutes.general.threadId;
    assert.notEqual(threadId, host.oldThreadId);
    assert.equal(repaired.revision, host.originalRoute.revision + 1);
    assert.deepEqual(repaired.scopeStarts, host.originalRoute.scopeStarts);
    assert.deepEqual(repaired.agentRoutes, host.originalRoute.agentRoutes);
    assert.ok(Object.keys(repaired.agentRoutes).length > 0);
    assert.equal((await host.view()).reconcileRequired, false);
    assert.equal((await host.inboxItem()).disposition, 'route_failed', 'repair itself does not rewrite the inbox');
    assert.deepEqual(await host.dispatcher.dispatchConnection(host.cafe.connectionId), { ...emptyDispatch, routed: 1 });
    const delivered = await host.inboxItem();
    assert.equal(delivered.disposition, 'routed');
    assert.equal(delivered.routeConfigRevision, repaired.revision);
    assert.equal(delivered.routeFailure, undefined, 'the existing contract replaces the failed delivery state');
    assert.deepEqual(delivered.event, host.event, 'this is a second delivery of the old event, not a new mention');
    assert.equal(delivered.routeReceipt?.kind, 'thread_message');
    assert.ok(delivered.routeReceipt?.kind === 'thread_message');
    const receipt = delivered.routeReceipt;
    assert.equal(receipt.threadId, threadId);
    assert.equal(receipt.catId, 'codex-sol');
    const message = await host.messages.getById(receipt.messageId);
    assert.equal(message?.content, host.event.body);
    assert.deepEqual(message?.extra?.targetCats, ['codex-sol']);
    assert.equal(message?.source?.connector, 'collective');
    const projected = (await host.view()).requests.find((request) => request.event.eventId === host.event.eventId);
    assert.equal(projected?.delivery, 'routed');
    assert.equal(projected?.failure, undefined);
    assert.equal(projected?.messageId, receipt.messageId);
    assert.deepEqual(host.processed, [{ threadId, userId: host.cafe.ownerUserId }]);
    assert.equal(host.queue.size(threadId, host.cafe.ownerUserId), 1);
    const threadCount = host.threads.list(host.cafe.ownerUserId).length;
    assert.equal(
      (await host.reconcile()).revision,
      repaired.revision,
      'healthy reconciliation does not advance revision',
    );
    assert.equal(host.threads.list(host.cafe.ownerUserId).length, threadCount);
    await world.syncAll();
    assert.deepEqual(await host.dispatcher.dispatchConnection(host.cafe.connectionId), emptyDispatch);
    assert.equal(
      host.messages.getByThreadIncludingQueued(threadId, 50, host.cafe.ownerUserId).length,
      1,
      'repeat sync does not duplicate the queued message',
    );
    assert.equal(host.queue.size(threadId, host.cafe.ownerUserId), 1, 'repeat sync does not duplicate the queue entry');
    assert.equal(host.processed.length, 1);
    assert.deepEqual(await host.inboxItem(), delivered);
  } finally {
    await world.close();
  }
});

test('endpoint repair cannot redeliver a failed mention after its participation scope ends', async () => {
  const world = await createWorld();
  try {
    const host = await brokenEndpoint(world);
    await host.reconcile({ defaultMode: 'include', excludedCatIds: ['codex-sol'], channelOverrides: {} });
    const reincluded = await host.reconcile({ defaultMode: 'include', excludedCatIds: [], channelOverrides: {} });
    assert.notDeepEqual(reincluded.scopeStarts, host.originalRoute.scopeStarts, 're-inclusion starts a new epoch');
    assert.deepEqual(reincluded.agentRoutes, host.originalRoute.agentRoutes);
    assert.deepEqual(await host.dispatcher.dispatchConnection(host.cafe.connectionId), { ...emptyDispatch, failed: 1 });
    const failed = await host.inboxItem();
    assert.equal(failed.disposition, 'route_failed');
    assert.equal(failed.routeFailure?.code, 'PARTICIPATION_REVOKED');
    assert.equal(failed.routeReceipt, undefined);
    assert.deepEqual(failed.event, host.event);
    const threadId = reincluded.channelRoutes.general.threadId;
    assert.equal(host.messages.getByThreadIncludingQueued(threadId, 50, host.cafe.ownerUserId).length, 0);
    assert.equal(host.queue.size(threadId, host.cafe.ownerUserId), 0);
    assert.deepEqual(host.processed, []);
    assert.deepEqual(await host.dispatcher.dispatchConnection(host.cafe.connectionId), emptyDispatch);
  } finally {
    await world.close();
  }
});
