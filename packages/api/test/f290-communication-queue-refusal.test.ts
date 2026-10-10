import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
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
import { QueueProcessor, type RouterLike } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore, settleLifecycleResponseInputs } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import './helpers/setup-cat-registry.js';

const catId = createCatId('codex-sol'),
  threadId = 'private-queue',
  userId = 'owner';
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Queue transition timed out: ' + label);
}
function fixture(refuse: (source: string) => unknown, unsupported = false, retryDelayMs = 60_000) {
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger),
    messages = new MessageStore();
  const records = new InvocationRecordStore(),
    turns = new InMemoryTurnExecutionStore();
  const routed: string[] = [],
    delivered: string[] = [],
    parentIds: string[] = [],
    errors: unknown[] = [];
  let modelStarts = 0;
  const router: RouterLike = {
    async resolveExplicitTargets(targets) {
      return [...targets];
    },
    async resolveConversationTargetsAtAdmission(targets) {
      return [...targets];
    },
    async *routeExecution(_user, content, _thread, messageId, targets, _intent, options) {
      routed.push(content);
      const refusal = refuse(content);
      if (refusal || unsupported) {
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
          yield* invokeSingleCat(deps, {
            catId,
            userId,
            threadId,
            executionScope: 'collective-work',
            prompt: content,
            isLastCat: true,
            service: {
              supportsToolExecutionPolicy: () => false,
              async *invoke() {
                modelStarts++;
              },
            },
          });
        } finally {
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        }
        assert.fail('Private refusal must stop before provider creation');
      }
      const invocationId = randomUUID(),
        parentInvocationId = String(options?.parentInvocationId),
        startedAt = Date.now();
      turns.createRunning({
        invocationId,
        parentInvocationId,
        threadId,
        userId,
        catId,
        executionKind: 'ordinary',
        startedAt,
        causal: { triggerMessageId: messageId ?? undefined },
      });
      const admission = await options!.onLifecycleInvocationStarted!({
        invocationId,
        parentInvocationId,
        threadId,
        userId,
        catId,
        startedAt,
      });
      assert.ok(admission);
      yield {
        type: 'system_info',
        catId,
        invocationId,
        turnInvocationId: invocationId,
        turnExecutionStartedAt: startedAt,
        timestamp: startedAt,
        responseMessageId: admission.responseMessageId,
        extra: { turnExecution: { executionKind: 'ordinary', invocationId, parentInvocationId } },
      };
      delivered.push(content);
      turns.transitionTerminal(invocationId, {
        status: 'succeeded',
        terminalReason: 'fixture_delivery_complete',
        endedAt: Date.now(),
      });
      const terminal = messages.commitLifecycleResponseTerminal(admission.responseMessageId, {
        invocationId,
        status: 'completed',
        completedAt: Date.now(),
        content: 'transport result',
        mentions: [],
        origin: 'stream',
      });
      assert.equal(terminal.kind, 'applied');
      if (terminal.kind === 'applied')
        await settleLifecycleResponseInputs(messages, terminal.message, admission.responseMessageId);
      yield { type: 'done', catId: targets[0], invocationId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const processor = new QueueProcessor(
    {
      queue,
      invocationTracker: new InvocationTracker(),
      messageStore: messages,
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
      log: {
        info() {},
        warn() {},
        error(value) {
          errors.push(value);
        },
      },
    },
    { retryDeferral: { baseDelayMs: retryDelayMs } },
  );
  async function enqueue(content: string) {
    const [taskId, revision] = content.split('@');
    return queue.send(
      messages,
      {
        userId,
        threadId,
        from: { kind: 'system', service: 'collective-work' },
        content,
        mentions: [catId],
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        extra: {
          collectiveWorkInvocationV1: {
            v: 1,
            taskId: taskId!,
            observedRevision: Number(revision),
            resultRevision: 1,
            executionRevision: Number(revision),
            executionRef: 'message:admission-' + content,
          },
        },
      },
      {
        kind: 'conversation_input',
        threadId,
        userId,
        from: { kind: 'system', service: 'collective-work' },
        ownerAuthProvenance: 'unknown',
        executionScope: 'collective-work',
        content,
        targetCats: [catId],
        intent: 'execute',
        idempotencyKey: 'source:' + content,
      },
    );
  }
  async function cold() {
    const restarted = new InvocationQueue(ledger);
    await restarted.hydrateFromLedger(messages);
    return restarted.list(threadId, userId);
  }
  return {
    queue,
    messages,
    records,
    processor,
    routed,
    delivered,
    errors,
    enqueue,
    cold,
    parentRecords: () => parentIds.map((id) => records.get(id)!),
    modelStarts: () => modelStarts,
  };
}

for (const code of ['WORK_EXECUTION_NOT_CURRENT', 'OWNER_ADMISSION_UNAVAILABLE']) {
  test('a permanent ' + code + ' retires only stale A@1 and lets current A@2 and B proceed', async () => {
    const f = fixture((source) => (source === 'task-A@1' ? Object.assign(new Error(code), { code }) : undefined));
    const stale = await f.enqueue('task-A@1'),
      current = await f.enqueue('task-A@2'),
      independent = await f.enqueue('task-B@1');
    await f.processor.requestDrain(threadId, userId);
    await until(() => f.messages.getById(stale.message.id)?.deliveryStatus === 'canceled', 'stale cancellation');
    await until(() => f.queue.list(threadId, userId).length === 0, 'remaining delivery');
    assert.deepEqual(f.routed, ['task-A@1', 'task-A@2', 'task-B@1']);
    assert.deepEqual(f.delivered, ['task-A@2', 'task-B@1']);
    assert.equal(f.modelStarts(), 0);
    const refused = f.messages.getById(stale.message.id)!;
    assert.equal(refused.queueCustody, undefined);
    assert.equal(refused.content, stale.message.content);
    assert.equal(refused.lifecycle?.kind, 'input');
    assert.equal(f.messages.getById(current.message.id)?.deliveryStatus, 'delivered');
    assert.equal(f.messages.getById(independent.message.id)?.deliveryStatus, 'delivered');
    assert.deepEqual(await f.cold(), []);
    const record = f.parentRecords().find((row) => row.userMessageId === stale.message.id);
    assert.equal(record?.status, 'failed');
    assert.match(record?.error ?? '', /collective_private_work_refused/);
    assert.equal(f.routed.filter((content) => content === 'task-A@1').length, 1);
  });
}

test('an unsupported private provider retires its exact source without reporting successful Work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-queue-refusal-'));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = root;
  try {
    const f = fixture(() => undefined, true);
    const source = await f.enqueue('task-A@1');
    await f.processor.requestDrain(threadId, userId);
    await until(() => f.messages.getById(source.message.id)?.deliveryStatus === 'canceled', 'unsupported cancellation');
    await until(() => f.queue.list(threadId, userId).length === 0, 'unsupported retirement');
    assert.deepEqual(f.delivered, []);
    assert.equal(f.modelStarts(), 0);
    assert.equal(f.parentRecords()[0]?.status, 'failed');
    assert.match(f.parentRecords()[0]?.error ?? '', /private_provider_unsupported/);
    assert.deepEqual(await f.cold(), []);
  } finally {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    // The private-work fixture directory remains available for audit.
  }
});

test('temporary Service failure preserves the exact pending source and retries after its bounded backoff', async () => {
  let unavailable = true;
  const f = fixture(
    () =>
      unavailable ? Object.assign(new Error('authority transport unavailable'), { code: 'ECONNRESET' }) : undefined,
    false,
    200,
  );
  const source = await f.enqueue('task-A@2');
  await f.processor.requestDrain(threadId, userId);
  await until(() => f.parentRecords()[0]?.status === 'failed', 'failed attempt');
  await until(() => f.queue.list(threadId, userId)[0]?.status === 'queued', 'claim restored');
  assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
  assert.deepEqual(
    (await f.cold()).map((row) => row.id),
    [source.entry!.id],
  );
  assert.deepEqual(f.delivered, []);
  unavailable = false;
  await f.processor.requestDrain(threadId, userId);
  await until(() => f.messages.getById(source.message.id)?.deliveryStatus === 'delivered', 'recovered delivery');
  assert.deepEqual(f.routed, ['task-A@2', 'task-A@2']);
  assert.deepEqual(f.delivered, ['task-A@2']);
  assert.equal(f.messages.getById(source.message.id)?.lifecycle?.dispatchRefs?.length, 1);
  assert.equal(f.messages.getByThread(threadId, 50, userId).filter((m) => m.lifecycle?.kind === 'response').length, 1);
});

test('unknown History at pending retry preserves its exact claim until cold recovery, without starting a receiver', async () => {
  const f = fixture(
    () => Object.assign(new Error('authority transport unavailable'), { code: 'ECONNRESET' }),
    false,
    50,
  );
  const source = await f.enqueue('task-A@2');
  const create = f.records.create.bind(f.records);
  const read = f.messages.getById.bind(f.messages);
  let unavailable = false;
  let replayObserved = false;
  f.records.create = (input) => {
    const result = create(input);
    if (result.outcome === 'duplicate') {
      unavailable = true;
      replayObserved = true;
    }
    return result;
  };
  f.messages.getById = (id) => {
    if (unavailable && id === source.message.id) throw new Error('fixture History read unavailable');
    return read(id);
  };
  await f.processor.requestDrain(threadId, userId);
  await until(
    async () => replayObserved && (await f.queue.getDurableEntry(threadId, source.entry!.id))?.status === 'claimed',
    'unknown retry claim',
  );
  assert.deepEqual(f.routed, ['task-A@2']);
  assert.deepEqual(f.delivered, []);
  assert.equal(read(source.message.id)?.deliveryStatus, 'queued');
  assert.equal(read(source.message.id)?.lifecycle?.dispatchRefs?.length ?? 0, 0);
  unavailable = false;
  assert.deepEqual(
    (await f.cold()).map((row) => [row.id, row.status]),
    [[source.entry!.id, 'queued']],
  );
});

for (const unavailableWriter of ['terminal-record', 'source-cancellation']) {
  test('a ' + unavailableWriter + ' outage keeps the refused source recoverable instead of consuming it', async () => {
    const f = fixture(() => Object.assign(new Error('stale source'), { code: 'WORK_EXECUTION_NOT_CURRENT' }));
    const source = await f.enqueue('task-A@1');
    if (unavailableWriter === 'terminal-record') {
      const update = f.records.update.bind(f.records);
      f.records.update = (id, input) => (input.status === 'failed' ? null : update(id, input));
    } else
      f.messages.markCanceled = () => {
        throw new Error('source writer unavailable');
      };
    await f.processor.requestDrain(threadId, userId);
    await until(() => f.errors.length > 0, 'failed closed settlement');
    assert.equal(f.messages.getById(source.message.id)?.deliveryStatus, 'queued');
    assert.deepEqual(
      (await f.cold()).map((row) => row.id),
      [source.entry!.id],
    );
    assert.deepEqual(f.delivered, []);
    assert.equal(f.modelStarts(), 0);
    assert.equal(f.messages.getById(source.message.id)?.lifecycle?.dispatchRefs?.length ?? 0, 0);
  });
}
