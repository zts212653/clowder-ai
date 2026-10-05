import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  type InvocationDeps,
  invokeSingleCat,
} from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import {
  buildQueueEntry,
  groupActiveMessages,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import { QueueProcessor, type RouterLike } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import './helpers/setup-cat-registry.js';

const catId = createCatId('codex-sol');
const threadId = 'private-queue';
const userId = 'owner';

function required<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Queue transition timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fixture(refuse: (source: string) => unknown, unsupported = false) {
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const routed: string[] = [];
  const delivered: string[] = [];
  const parentIds: string[] = [];
  let modelStarts = 0;
  const router: RouterLike = {
    async *routeExecution(_user, content, _thread, messageId, targets, _intent, options) {
      routed.push(content);
      const refusal = refuse(content);
      if (refusal || unsupported) {
        // Exercise the real pre-provider authority/support boundary. No model is called.
        const deps = {
          collectiveContext: () => ({
            async resolvePrivate() {
              if (refusal) throw refusal;
              return {
                work: { task: { id: 'task-A' }, executionRevision: 1, authorityRef: 'message:owner-admission' },
              };
            },
          }),
        } as unknown as InvocationDeps;
        try {
          for await (const event of invokeSingleCat(deps, {
            catId,
            userId,
            threadId,
            executionScope: 'collective-work',
            prompt: content,
            isLastCat: true,
            service: {
              supportsToolExecutionPolicy: () => false,
              async *invoke() {
                modelStarts += 1;
                yield {
                  type: 'error' as const,
                  catId,
                  error: 'fixture provider must remain blocked',
                  timestamp: Date.now(),
                };
              },
            },
          }))
            yield { ...event };
        } finally {
          // Production routeSerial guarantees a done frame even before a refusal propagates.
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        }
        assert.fail('The private refusal must throw before provider creation');
      }
      // A deterministic transport completion supplies real child/custody evidence,
      // without fabricating a successful private Task or launching any model.
      const invocationId = randomUUID();
      const parentInvocationId = String(options?.parentInvocationId);
      const startedAt = Date.now();
      turns.createRunning({
        invocationId,
        parentInvocationId,
        threadId,
        userId,
        catId,
        startedAt,
        executionKind: 'ordinary',
        causal: { triggerMessageId: messageId ?? undefined },
      });
      yield {
        type: 'system_info',
        catId,
        invocationId,
        turnInvocationId: invocationId,
        turnExecutionStartedAt: startedAt,
        timestamp: startedAt,
        extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
      };
      const expose = options?.onPromptMessagesExposed as (input: unknown) => Promise<unknown>;
      await expose({
        threadId,
        userId,
        catId,
        invocationId,
        messageIds: options?.persistedPromptMessageIds,
        seenAt: Date.now(),
      });
      delivered.push(content);
      turns.transitionTerminal(invocationId, {
        status: 'succeeded',
        terminalReason: 'fixture_delivery_complete',
        endedAt: Date.now(),
      });
      yield { type: 'done', catId: targets[0], invocationId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: new InvocationTracker(),
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: turns,
    router,
    invocationRecordStore: {
      async create(input) {
        const result = records.create(input as Parameters<InvocationRecordStore['create']>[0]);
        parentIds.push(result.invocationId);
        return result;
      },
      get: (id) => records.get(id),
      async update(id, input) {
        return records.update(id, input as Parameters<InvocationRecordStore['update']>[1]);
      },
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  function enqueue(content: string) {
    const result = queue.enqueue({
      threadId,
      userId,
      ownerAuthProvenance: 'unknown',
      executionScope: 'collective-work',
      content,
      source: 'connector',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
      idempotencyKey: `source:${content}`,
    });
    assert.ok(result.entry);
    const entry = result.entry;
    const [taskId, revision] = content.split('@');
    const message = messages.append({
      userId,
      threadId,
      catId: null,
      content,
      mentions: [catId],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(entry),
      extra: {
        collectiveWorkInvocationV1: {
          v: 1,
          taskId: required(taskId),
          observedRevision: Number(revision),
          resultRevision: 1,
          executionRevision: Number(revision),
          executionRef: `message:admission-${content}`,
        },
      },
    });
    queue.backfillMessageId(threadId, userId, entry.id, message.id);
    return { entry, message };
  }
  return {
    queue,
    messages,
    records,
    coordinator,
    processor,
    routed,
    delivered,
    enqueue,
    parentRecords: () => parentIds.map((id) => required(records.get(id))),
    modelStarts: () => modelStarts,
  };
}

for (const code of ['WORK_EXECUTION_NOT_CURRENT', 'OWNER_ADMISSION_UNAVAILABLE']) {
  test(`a permanent ${code} retires stale A@1 durably and lets current A@2 and B proceed`, async () => {
    const f = fixture((source) => (source === 'task-A@1' ? Object.assign(new Error(code), { code }) : undefined));
    const stale = f.enqueue('task-A@1');
    const current = f.enqueue('task-A@2');
    const independent = f.enqueue('task-B@1');
    assert.equal((await f.processor.processNext(threadId, userId)).started, true);
    await waitFor(
      () => f.messages.getById(stale.message.id)?.deliveryStatus === 'canceled',
      'stale source cancellation',
    );
    await waitFor(() => f.queue.list(threadId, userId).length === 0, 'new current and independent source completion');
    assert.deepEqual(f.routed, ['task-A@1', 'task-A@2', 'task-B@1']);
    assert.deepEqual(f.delivered, ['task-A@2', 'task-B@1']);
    assert.equal(f.modelStarts(), 0);
    const refused = required(f.messages.getById(stale.message.id));
    assert.equal(refused.queueCustody, undefined);
    assert.equal(refused.content, stale.message.content);
    assert.equal(f.messages.getById(current.message.id)?.deliveryStatus, 'delivered');
    assert.equal(f.messages.getById(independent.message.id)?.deliveryStatus, 'delivered');
    const sourceRows = [stale, current, independent].map(({ message }) => required(f.messages.getById(message.id)));
    const recovered = [...groupActiveMessages(sourceRows)].map(([id, rows]) => buildQueueEntry(rows, id));
    assert.deepEqual(recovered, [], 'restart must never reconstruct the refused old source');
    const record = f.parentRecords().find((row) => row.userMessageId === stale.message.id);
    assert.equal(record?.status, 'canceled');
    assert.match(record?.error ?? '', /collective_private_work_refused/);
    assert.equal(f.processor.isPaused(threadId, catId), false);
  });
}

test('an unsupported private provider is terminal for its exact carrier, without reporting successful work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-queue-refusal-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  try {
    const f = fixture(() => undefined, true);
    const source = f.enqueue('task-A@1');
    assert.equal((await f.processor.processNext(threadId, userId)).started, true);
    await waitFor(
      () => f.messages.getById(source.message.id)?.deliveryStatus === 'canceled',
      'unsupported provider cancellation',
    );
    await waitFor(() => f.queue.list(threadId, userId).length === 0, 'unsupported carrier removal');
    assert.deepEqual(f.delivered, []);
    assert.equal(f.modelStarts(), 0);
    assert.equal(f.parentRecords()[0]?.status, 'canceled');
    assert.match(f.parentRecords()[0]?.error ?? '', /private_provider_unsupported/);
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a Service transport failure retains and retries the exact source when the transport recovers', async () => {
  let unavailable = true;
  const f = fixture(() =>
    unavailable ? Object.assign(new Error('authority transport unavailable'), { code: 'ECONNRESET' }) : undefined,
  );
  const source = f.enqueue('task-A@2');
  assert.equal((await f.processor.processNext(threadId, userId)).started, true);
  await waitFor(
    () => f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1)?.state === 'failed',
    'retryable failure receipt',
  );
  const retained = required(f.messages.getById(source.message.id));
  assert.equal(retained.deliveryStatus, 'queued');
  assert.equal(retained.queueCustody?.entryId, source.entry.id);
  assert.deepEqual(
    f.queue.list(threadId, userId).map((entry) => entry.id),
    [source.entry.id],
  );
  assert.deepEqual(f.delivered, []);
  const expectedAttemptId = required(retained.queueCustody?.targetAttempts?.at(-1)).id;
  unavailable = false;
  const retried = await f.processor.retryFailedTarget(
    threadId,
    userId,
    source.entry.id,
    catId,
    expectedAttemptId,
    async (transitions) => {
      for (const transition of transitions) {
        const committed = f.messages.transitionQueueCustody(transition.messageId, {
          expectedRevision: transition.current.revision,
          next: transition.next,
        });
        assert.equal(committed.kind, 'updated');
      }
      return { outcome: 'committed' };
    },
  );
  assert.equal(retried.outcome, 'retried');
  await waitFor(
    () => f.messages.getById(source.message.id)?.deliveryStatus === 'delivered',
    'recovered source completion',
  );
  assert.deepEqual(f.routed, ['task-A@2', 'task-A@2']);
  assert.deepEqual(f.delivered, ['task-A@2']);
  assert.equal(f.messages.getById(source.message.id)?.queueCustody?.entryId, source.entry.id);
  assert.equal(f.messages.getByThreadAfter(threadId).length, 1, 'retry must retain the same durable message');
});

for (const unavailableWriter of ['terminal-record', 'source-cancellation']) {
  test(`a ${unavailableWriter} outage preserves refused source custody instead of consuming it`, async () => {
    const f = fixture(() => Object.assign(new Error('stale source'), { code: 'WORK_EXECUTION_NOT_CURRENT' }));
    const source = f.enqueue('task-A@1');
    if (unavailableWriter === 'terminal-record') {
      const update = f.records.update.bind(f.records);
      f.records.update = (id, input) => (input.status === 'canceled' ? null : update(id, input));
    } else {
      f.messages.markCanceled = () => {
        throw new Error('source writer unavailable');
      };
    }
    assert.equal((await f.processor.processNext(threadId, userId)).started, true);
    await waitFor(
      () => f.messages.getById(source.message.id)?.queueCustody?.targetAttempts?.at(-1)?.state === 'failed',
      'failed terminal writer retained custody',
    );
    const retained = required(f.messages.getById(source.message.id));
    assert.equal(retained.deliveryStatus, 'queued');
    assert.equal(retained.queueCustody?.entryId, source.entry.id);
    assert.deepEqual(
      f.queue.list(threadId, userId).map((entry) => [entry.id, entry.status]),
      [[source.entry.id, 'queued']],
    );
    assert.deepEqual(f.routed, ['task-A@1']);
    assert.deepEqual(f.delivered, []);
    assert.equal(f.modelStarts(), 0);
  });
}
