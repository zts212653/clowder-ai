import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CollectivePrivateWorkRefusalError } from '../src/domains/cats/services/agents/invocation/collective-private-refusal.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { CollectiveWorkDispatcher } from '../src/domains/plugin/builtin-runtime/collective-work-dispatcher.ts';

// Actual production QueueProcessor and History/ledger cutover. The router and
// current domain permission ports are deterministic, not a model/grant/Redis claim.
async function fixture(route, overrides = {}) {
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const records = new Map();
  const calls = [];
  const repairs = [];
  const errors = [];
  const invocationRecordStore = {
    create: async (input) => {
      records.set('isolated-parent', { id: 'isolated-parent', ...input, status: 'queued' });
      return { outcome: 'created', invocationId: 'isolated-parent' };
    },
    get: async (id) => records.get(id) ?? null,
    update: async (id, patch) => {
      const current = records.get(id);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes };
      records.set(id, next);
      return next;
    },
  };
  const processor = new QueueProcessor(
    {
      queue,
      messageStore: messages,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore,
      router: {
        resolveExplicitTargets: async (targets) => [...targets],
        resolveConversationTargetsAtAdmission: async (targets) => [...targets],
        routeExecution: async function* (...args) {
          calls.push(args);
          yield* route(...args);
        },
        ackCollectedCursors: async () => {},
      },
      repairDispatchReceipts: async (input) => {
        repairs.push(input);
      },
      socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
      log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
      ...overrides,
    },
    { retryDeferral: { baseDelayMs: 60_000 } },
  );
  const task = {
    id: 'processor-task',
    threadId: 'processor-thread',
    userId: 'isolated-owner',
    ownerCatId: 'codex',
    entrustedWork: { revision: 1, intendedOutcome: 'processor seam' },
  };
  const dispatcher = new CollectiveWorkDispatcher({
    invocationQueue: queue,
    messageStore: messages,
    threadStore: { get: async () => ({ createdBy: task.userId, participants: ['codex'] }) },
    context: () => ({ resolvePrivate: async () => ({ admitted: true }) }),
  });
  const receipt = await dispatcher.dispatch(task, task.userId, 1, { kind: 'admission' });
  return { queue, messages, records, calls, repairs, errors, processor, task, receipt };
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`processor seam timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test('C7 processor cannot grant stale source/receipt writers authority over canonical History delivery', async () => {
  let legacyWrites = 0;
  const f = await fixture(
    async function* (userId, _body, threadId, _source, targets, _intent, options) {
      await options.onLifecycleInvocationStarted({
        userId,
        threadId,
        catId: targets[0],
        invocationId: 'isolated-c7-child',
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      yield { type: 'done', catId: targets[0], invocationId: 'isolated-c7-child', timestamp: Date.now() };
    },
    {
      repairDispatchSource: async () => {
        legacyWrites++;
        throw new Error('retired source owner');
      },
      repairDispatchReceipts: async () => {
        legacyWrites++;
        throw new Error('retired receipt owner');
      },
    },
  );
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.records.get('isolated-parent')?.status === 'succeeded', 'canonical terminal');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId).length === 0, 'canonical target retirement');
  assert.equal(legacyWrites, 0);
  const source = f.messages.getById(f.receipt.messageId);
  assert.equal(source.lifecycle.dispatchRefs.length, 1);
  assert.equal(
    f.messages.getById(source.lifecycle.dispatchRefs[0].statusMessageId).lifecycle.invocationId,
    'isolated-c7-child',
  );
});

test('C7 unknown History after claim restores exact pending target without admitting provider', async () => {
  const f = await fixture(async function* () {
    assert.fail('unknown History cannot admit provider');
  });
  const [before] = f.queue.list(f.task.threadId, f.task.userId);
  f.messages.getById = () => {
    throw new Error('isolated History unavailable');
  };
  await assert.rejects(f.processor.processNext(f.task.threadId, f.task.userId), /isolated History unavailable/);
  assert.equal(f.calls.length, 0);
  const [after] = f.queue.list(f.task.threadId, f.task.userId);
  assert.equal(after.id, before.id);
  assert.equal(after.status, 'queued');
  assert.deepEqual(after.execution, before.execution);
});
test('real processor forwards immutable domain scope and durably refuses before receiver/provider admission', async () => {
  const f = await fixture(async function* (_owner, _body, _thread, _source, _targets, _intent, options) {
    assert.equal(options.executionScope, 'collective-work');
    assert.equal(options.ownerAuthProvenance, 'unknown');
    throw new CollectivePrivateWorkRefusalError('work_execution_not_current', 'isolated authority expired');
  });
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.messages.getById(f.receipt.messageId).deliveryStatus === 'canceled', 'refusal cancellation');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId).length === 0, 'pending retirement');
  assert.equal(f.calls.length, 1);
  assert.equal(f.records.get('isolated-parent').status, 'failed');
  assert.match(f.records.get('isolated-parent').error, /collective_private_work_refused/);
  assert.equal(f.messages.getByThread(f.task.threadId).filter((m) => m.lifecycle?.kind === 'response').length, 0);
  assert.deepEqual(await f.queue.listAllDurable(f.task.threadId), []);
});
test('transport failure restores the exact scoped pending row without publishing a receiver', async () => {
  const f = await fixture(async function* () {
    throw new Error('isolated transport offline');
  });
  const [before] = f.queue.list(f.task.threadId, f.task.userId);
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.records.get('isolated-parent')?.status === 'failed', 'transport terminal');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId)[0]?.status === 'queued', 'claim restore');
  const [after] = f.queue.list(f.task.threadId, f.task.userId);
  assert.equal(after.id, before.id);
  assert.deepEqual(after.execution, before.execution);
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'queued');
  assert.equal(f.messages.getByThread(f.task.threadId).filter((m) => m.lifecycle?.kind === 'response').length, 0);
});
test('real processor commits the exact admitted child rather than substituting its parent', async () => {
  const f = await fixture(async function* (userId, _body, threadId, _source, targets, _intent, options) {
    await options.onLifecycleInvocationStarted({
      userId,
      threadId,
      catId: targets[0],
      invocationId: 'isolated-child',
      parentInvocationId: options.parentInvocationId,
      startedAt: Date.now(),
    });
    yield { type: 'done', catId: targets[0], invocationId: 'isolated-child', timestamp: Date.now() };
  });
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.records.get('isolated-parent')?.status === 'succeeded', 'exact child terminal');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId).length === 0, 'canonical retirement');
  assert.deepEqual(f.repairs, [], 'obsolete repair is not a second completion owner');
  const source = f.messages.getById(f.receipt.messageId);
  assert.equal(source.deliveryStatus, 'delivered');
  const response = f.messages.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
  assert.equal(response.lifecycle.invocationId, 'isolated-child');
  assert.deepEqual(await f.queue.listAllDurable(f.task.threadId), []);
});

test('History lookup failure at provider admission restores claim without starting provider route', async () => {
  const f = await fixture(async function* () {
    assert.fail('provider route must not start');
  });
  const [before] = f.queue.list(f.task.threadId, f.task.userId);
  const get = f.messages.getById.bind(f.messages);
  let reads = 0;
  f.messages.getById = (id) => {
    if (id === f.receipt.messageId && ++reads === 2) throw new Error('isolated admission History unavailable');
    return get(id);
  };
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.records.get('isolated-parent')?.status === 'failed', 'History admission refusal');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId)[0]?.status === 'queued', 'History claim restore');
  assert.equal(f.calls.length, 0);
  const [after] = f.queue.list(f.task.threadId, f.task.userId);
  assert.equal(after.id, before.id);
  assert.equal(after.status, 'queued');
  assert.equal(get(f.receipt.messageId).deliveryStatus, 'queued');
});

test('refusal evidence rejected by the record store cannot cancel or retire the pending source', async () => {
  const f = await fixture(async function* () {
    throw new CollectivePrivateWorkRefusalError('owner_admission_unavailable', 'isolated refusal');
  });
  const update = f.processor.deps.invocationRecordStore.update;
  f.processor.deps.invocationRecordStore.update = async (id, patch) =>
    patch.error?.startsWith('collective_private') ? null : update(id, patch);
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(
    () => f.errors.some((args) => String(args[1]).includes('Queue attempt settlement failed')),
    'failed evidence',
  );
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'queued');
  assert.equal((await f.queue.listAllDurable(f.task.threadId)).length, 1);
});

test('stale receipt sink is never invoked and cannot suppress canonical cleanup', async () => {
  let staleCalls = 0;
  const f = await fixture(
    async function* (userId, _body, threadId, _source, targets, _intent, options) {
      await options.onLifecycleInvocationStarted({
        userId,
        threadId,
        catId: targets[0],
        invocationId: 'isolated-repair-failure-child',
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      yield { type: 'done', catId: targets[0], invocationId: 'isolated-repair-failure-child', timestamp: Date.now() };
    },
    {
      repairDispatchReceipts: async () => {
        staleCalls++;
        throw new Error('isolated receipt sink unavailable');
      },
    },
  );
  assert.equal((await f.processor.processNext(f.task.threadId, f.task.userId)).started, true);
  await waitFor(() => f.records.get('isolated-parent')?.status === 'succeeded', 'canonical terminal');
  await waitFor(() => f.queue.list(f.task.threadId, f.task.userId).length === 0, 'canonical cleanup');
  assert.equal(staleCalls, 0);
  assert.equal(f.messages.getById(f.receipt.messageId).deliveryStatus, 'delivered');
  assert.deepEqual(await f.queue.listAllDurable(f.task.threadId), []);
});
