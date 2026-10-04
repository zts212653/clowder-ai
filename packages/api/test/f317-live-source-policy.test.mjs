import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { resolveRestartTargets } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyRestartTargets.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

async function fixture(missingChild = false) {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const sources = [null, 'opus'].map((catId) =>
    messages.append({
      userId: 'owner',
      threadId: 'home',
      catId,
      content: 'check this source',
      mentions: ['codex'],
      timestamp: 1_000,
      deliveryStatus: 'queued',
    }),
  );
  const admitted = queue.enqueue({
    threadId: 'home',
    userId: 'owner',
    messageId: sources[0].id,
    content: 'mixed carrier',
    targetCats: ['codex'],
    source: 'user',
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  });
  const entry = { ...admitted.entry, mergedMessageIds: [sources[1].id] };
  assert.equal(queue.restoreEntrySnapshotIfUnchanged(admitted.entry, entry), true);
  for (const source of sources) {
    messages.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
    messages.append({
      userId: 'owner',
      threadId: 'home',
      catId: 'codex',
      content: 'The source is answered',
      mentions: [],
      timestamp: 2_000,
      replyTo: source.id,
      extra: { stream: { invocationId: 'live-child', turnInvocationId: 'live-child' } },
    });
  }
  queue.markQueuedSeen('home', 'owner', entry.id, 'codex', 'live-child', 1_200);
  await coordinator.persistEntry(queue.getEntrySnapshot('home', 'owner', entry.id));
  const a2a = messages.getById(sources[1].id);
  messages.transitionQueueCustody(a2a.id, {
    expectedRevision: a2a.queueCustody.revision,
    next: {
      ...a2a.queueCustody,
      revision: a2a.queueCustody.revision + 1,
      updatedAt: Date.now(),
      readEvidenceWitnesses: [
        {
          targetCatId: 'codex',
          invocationId: 'live-child',
          seenAt: 1_500,
          evidenceKind: 'full_contiguous_thread_context',
        },
      ],
    },
  });
  const executions = {
    get: async () =>
      missingChild
        ? null
        : {
            invocationId: 'live-child',
            parentInvocationId: 'parent',
            catId: 'codex',
            threadId: 'home',
            userId: 'owner',
            executionKind: 'ordinary',
            status: 'succeeded',
            startedAt: 1,
            endedAt: 3_000,
            queueCompletionPolicy: 'explicit_source',
          },
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: new InvocationTracker(),
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
    router: {
      routeExecution() {
        assert.fail('must not launch another child');
      },
      async ackCollectedCursors() {},
    },
  });
  return { messages, queue, coordinator, sources, executions, processor, entry };
}

test('FC-1: missing execution truth cannot erase an adopted source fence during restart', async () => {
  const h = await fixture(true);
  const source = h.messages.getById(h.sources[1].id);
  const next = await resolveRestartTargets(
    source,
    source.queueCustody,
    h.messages,
    { get: () => null },
    h.executions,
    new Set(),
    Date.now(),
  );
  assert.equal(next.handled.has('codex'), false);
  assert.equal(next.targetOutcomeByCatId.codex, undefined);
});

test('FC-2: a mixed carrier settles the answered user source while leaving the adopted dispatch unhandled', async () => {
  const h = await fixture();
  await h.processor.onInvocationComplete(
    'home',
    'codex',
    'succeeded',
    'parent',
    ['codex'],
    false,
    { codex: 'live-child' },
    [],
    {},
    true,
  );
  assert.deepEqual(h.messages.getById(h.sources[0].id).queueCustody.handledByCatIds, ['codex']);
  assert.deepEqual(h.messages.getById(h.sources[1].id).queueCustody.handledByCatIds, []);
  const entry = h.queue.getEntrySnapshot('home', 'owner', h.entry.id);
  assert.equal(entry.messageId, h.sources[1].id);
  assert.deepEqual(entry.mergedMessageIds, []);
});
