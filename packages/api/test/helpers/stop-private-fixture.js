import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../../dist/routes/queue.js';

export async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (!(await predicate())) {
    assert.ok(Date.now() < until, 'the actual Queue execution must settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function stopFixture(t, options = {}) {
  const ledger = options.ledger ?? new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger, { resolveTargets: async (ids) => [...ids] });
  const tracker = new InvocationTracker();
  const messages = options.messages ?? new MessageStore();
  const records = new InvocationRecordStore();
  const starts = [];
  const memberCompletions = new Map();
  const events = [];
  const socketManager = {
    emitToUser() {},
    broadcastToRoom() {},
    broadcastAgentMessage(message) {
      events.push(message);
    },
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: messages,
    invocationRecordStore: records,
    socketManager,
    // This fixture exercises valid pending notices; retention inventory belongs to its own guard tests.
    worktreeNoticeStartGuard: { check: async () => ({ ok: true }) },
    log: { info() {}, warn() {}, error() {} },
    router: {
      resolveExplicitTargets: async (ids) => [...ids],
      resolveConversationTargetsAtAdmission: async (ids) => [...ids],
      ackCollectedCursors: async () => {},
      async *routeExecution(userId, content, threadId, _messageId, targets, _intent, options) {
        for (const catId of targets)
          await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId,
            invocationId: randomUUID(),
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
        starts.push(content);
        if (content === 'active') {
          await Promise.all(
            targets.map((catId) => {
              const signal = tracker.getController(threadId, catId).signal;
              if (signal.aborted) return;
              return new Promise((resolve) => {
                memberCompletions.set(catId, resolve);
                signal.addEventListener('abort', resolve, { once: true });
              });
            }),
          );
        }
        for (const catId of targets) yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
      },
    },
  });
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => ({ id, createdBy: 'owner', participants: ['opus', 'codex'] }) },
    invocationQueue: queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    messageStore: messages,
    invocationRecordStore: records,
    socketManager,
    ...options.routes,
  });
  t.after(async () => {
    tracker.cancelAll('thread', 'owner', 'test_cleanup');
    await app.close();
  });
  const privateInput = (id, patch = {}) => ({
    kind: 'private_input',
    threadId: 'thread',
    userId: 'owner',
    sourceId: id,
    from: { kind: 'system', service: 'worktree-lifecycle' },
    ownerAuthProvenance: 'unknown',
    content: id,
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
    ...patch,
  });
  const send = async (content, targetCats = ['opus']) =>
    queue.send(
      messages,
      {
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'thread',
        content,
        mentions: targetCats,
        timestamp: Date.now(),
        deliveryStatus: 'queued',
      },
      {
        kind: 'conversation_input',
        threadId: 'thread',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        ownerAuthProvenance: 'unknown',
        content,
        targetCats,
        intent: 'execute',
        autoExecute: true,
      },
    );
  const active = options.idle ? undefined : await send('active', options.activeTargets);
  if (active) {
    await processor.requestDrain('thread');
    await waitFor(() => starts.length === 1);
  }
  const parent = tracker.getExecutionId('thread', 'opus');
  const stop = (legacy = false, catId = 'opus') =>
    app.inject({
      method: 'POST',
      url: legacy ? `/api/threads/thread/cancel/${catId}` : `/api/threads/thread/executions/live/${parent}/cancel`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: legacy ? {} : { catId },
    });
  return {
    ledger,
    queue,
    tracker,
    messages,
    records,
    processor,
    starts,
    app,
    privateInput,
    send,
    active,
    stop,
    parent,
    events,
    finishMember: (catId) => memberCompletions.get(catId)?.(),
  };
}
