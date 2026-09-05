import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { buildHandedCvoEvent, buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueuedMessageCustodyStartupReconciler } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { createA2ADispositionAuth, createA2ADispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';
import { runTerminalQueueHarness } from './helpers/issue1371-terminal-queue-harness.js';

for (const intent of ['done_notify', 'handoff']) {
  test(`#1371: exact dispatch can retire after unrelated thread ${intent}`, async () => {
    const h = await createA2ADispositionHarness();
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        messageId: 'unrelated-cvo-message',
        intent,
        at: 1_500,
      }),
    );
    const before = await h.projectionStore.get('ball:thread:thread-1');
    const result = await h.service.complete(createA2ADispositionAuth(h), 'completed');
    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, true);
    const after = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(after.state, before.state, 'exact retirement cannot alter unrelated thread state');
    assert.equal(after.holder, before.holder);
  });
}

test('#1371: a newer unrelated dispatch to the same cat keeps its active thread projection', async () => {
  const h = await createA2ADispositionHarness();
  const unrelated = h.messageStore.append({
    userId: 'user-1',
    catId: 'opus',
    content: 'Independent task',
    mentions: ['codex-sol'],
    timestamp: 1_500,
    threadId: 'thread-1',
  });
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: 'opus',
      toCatId: 'codex-sol',
      messageId: unrelated.id,
      at: 1_500,
    }),
  );
  const result = await h.service.complete(createA2ADispositionAuth(h), 'completed');
  assert.equal(result.retired, true);
  assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'active');
});

// Real dispatch service, projector, message custody coordinator and QueueProcessor.
// The provider is the only execution stub; it persists a source-bound reply.
for (const scenario of [
  'active control',
  'done_notify',
  'steer completed residue',
  'GET completed residue',
  'retirement unavailable',
  'restart after success',
]) {
  test(`#1371: replied cross-thread terminal has no live carrier (${scenario})`, async () => {
    const { h, terminal, queue, deps, entry, queued, processor, result, custody } =
      await runTerminalQueueHarness(scenario);
    assert.equal(result.status, 'succeeded');
    if (scenario === 'steer completed residue' || scenario === 'GET completed residue') {
      assert.equal(custody.status, 'terminal', 'the durable source was already handled');
      // Independent stale process-local snapshot: this fence must still be tested
      // after source-first settlement stops producing residue on the happy path.
      queue.restoreDurableEntry(queued);
      const activeController = deps.invocationTracker.start(
        terminal.threadId,
        'fable5',
        terminal.userId,
        ['fable5'],
        'unrelated-current-work',
      );
      const app = Fastify();
      try {
        await app.register(queueRoutes, {
          threadStore: { get: async () => ({ id: terminal.threadId, createdBy: terminal.userId }) },
          invocationQueue: queue,
          queueProcessor: processor,
          invocationTracker: deps.invocationTracker,
          socketManager: deps.socketManager,
          messageStore: h.messageStore,
          queueCustodyCoordinator: deps.queueCustodyCoordinator,
        });
        if (scenario === 'GET completed residue') {
          const response = await app.inject({
            method: 'GET',
            url: `/api/threads/${terminal.threadId}/queue`,
            headers: { 'x-cat-cafe-user': terminal.userId },
          });
          assert.equal(response.statusCode, 200);
          assert.deepEqual(response.json().queue, [], 'completed custody cannot be published as pending work');
          return;
        }
        const response = await app.inject({
          method: 'POST',
          url: `/api/threads/${terminal.threadId}/queue/${entry.id}/steer`,
          headers: { 'x-cat-cafe-user': terminal.userId },
          payload: {},
        });
        assert.equal(
          deps.router.routeExecution.mock.calls.length,
          1,
          'the existing provider no-reentry fence still holds',
        );
        assert.equal(
          activeController.signal.aborted,
          false,
          `already-consumed Queue residue must be rejected before preempting current work (HTTP ${response.statusCode})`,
        );
      } finally {
        await app.close();
      }
      return;
    }
    const observed = {
      liveCarriers: queue.list(terminal.threadId, terminal.userId).length,
      durableStatus: custody.status,
      handledTargets: custody.handledByCatIds,
      providerCalls: deps.router.routeExecution.mock.calls.length,
    };
    assert.deepEqual(
      observed,
      {
        liveCarriers: 0,
        durableStatus: 'terminal',
        handledTargets: ['fable5'],
        providerCalls: 1,
      },
      'a persisted exact-source response must settle carrier and receipt together',
    );
    if (scenario === 'restart after success') {
      // Serialize and reload durable records; no Queue or invocation state survives.
      const records = new Map(structuredClone(h.messageStore.getRecent(100)).map((message) => [message.id, message]));
      const recoveredStore = {
        getById: async (id) => structuredClone(records.get(id) ?? null),
        scanByDeliveryStatus: async (status) =>
          [...records.values()].filter((message) => message.deliveryStatus === status).map((message) => message.id),
      };
      const recoveredQueue = new InvocationQueue();
      const restored = await new QueuedMessageCustodyStartupReconciler({
        messageStore: recoveredStore,
        invocationQueue: recoveredQueue,
        invocationRecordStore: { get: async () => null },
        log: { info() {}, warn() {} },
      }).reconcile();
      const provider = mock.fn(async function* () {});
      const recoveredProcessor = new QueueProcessor({
        ...deps,
        queue: recoveredQueue,
        messageStore: recoveredStore,
        router: { routeExecution: provider },
      });
      for (const scope of restored.resumeScopes) {
        const next = recoveredQueue.markProcessing(scope.threadId, scope.userId);
        if (next) await recoveredProcessor.executeEntry(next);
      }
      assert.equal(restored.entriesRestored, 0);
      assert.equal(provider.mock.calls.length, 0);
    }
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      scenario === 'retirement unavailable' ? 0 : 1,
    );
  });
}
