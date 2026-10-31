import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { adaptInvocationQueue } from '../helpers/message-from-fixtures.js';
import '../helpers/setup-cat-registry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function runPreemptedParent(preemptAt) {
  const threadId = `thread-preempted-${preemptAt}-${randomUUID()}`;
  const queue = adaptInvocationQueue(new InvocationQueue());
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const beforeRunning = deferred();
  const releaseRunning = deferred();
  let providerCalls = 0;
  let originalController;
  let passedSignal;
  let replacementId;
  let replacementController;

  const installReplacement = () => {
    originalController = tracker.getController(threadId, 'codex-sol');
    assert.ok(originalController);
    const replacement = records.create({
      threadId,
      userId: 'operator',
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: randomUUID(),
      actionLeaseCarrier: { kind: 'none' },
    });
    replacementId = replacement.invocationId;
    records.update(replacementId, { status: 'running', expectedStatus: 'queued' });
    replacementController = tracker.start(threadId, 'codex-sol', 'operator', ['codex-sol'], replacementId);
  };

  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: {
      create: async (input) => {
        const parent = records.create(input);
        return parent;
      },
      get: (id) => records.get(id),
      update: async (id, input) => {
        if (preemptAt === 'before_route' && input.status === 'running') {
          beforeRunning.resolve();
          await releaseRunning.promise;
        }
        return records.update(id, input);
      },
    },
    router: {
      routeExecution: async function* (...args) {
        if (preemptAt === 'inside_route') installReplacement();
        passedSignal = args[6]?.signalForCat?.('codex-sol') ?? args[6]?.signal;
        if (passedSignal?.aborted) return;
        providerCalls += 1;
        yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
      },
      ackCollectedCursors: async () => {},
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    messageStore: new MessageStore(),
    log: { info() {}, warn() {}, error() {} },
  });

  queue.enqueue({
    kind: 'private_input',
    ownerAuthProvenance: 'unknown',
    threadId,
    userId: 'operator',
    content: 'Continue ordinary work',
    source: 'user',
    targetCats: ['codex-sol'],
    intent: 'execute',
    autoExecute: false,
  });
  const entry = await claimOnlyTarget(queue, threadId);
  assert.ok(entry);
  const pending = processor.executeEntry(entry);

  if (preemptAt === 'before_route') {
    await beforeRunning.promise;
    installReplacement();
    releaseRunning.resolve();
  }

  const result = await pending;
  assert.equal(originalController?.signal.aborted, true);
  assert.equal(originalController?.signal.reason, 'preempted');
  assert.equal(providerCalls, 0);
  assert.equal(replacementController?.signal.aborted, false);
  assert.equal(tracker.getExecutionId(threadId, 'codex-sol'), replacementId);
  if (preemptAt === 'inside_route') assert.equal(passedSignal, originalController?.signal);
  return result;
}

test('pre-route replacement reports a preempted admitted parent as canceled', async () => {
  const result = await runPreemptedParent('before_route');
  assert.equal(result.status, 'canceled');
});

test('in-route replacement keeps the same preempted terminal status', async () => {
  const result = await runPreemptedParent('inside_route');
  assert.equal(result.status, 'canceled');
});

async function claimOnlyTarget(queue, threadId) {
  const entry = queue.list(threadId, 'operator')[0];
  assert.ok(entry);
  const claimed = await queue.markProcessingGroupAcrossUsersDurable(
    threadId,
    { entryId: entry.id, targetCats: ['codex-sol'] },
    [entry.id],
  );
  return claimed?.entry;
}
