import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { PersistedQueueDelivery } = await import(
  '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js'
);
const { MessageStore, settleLifecycleResponseInputs } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { saveMessageDispositionPreference } = await import('../dist/config/user-preferences-store.js');
const appendPreferenceRoot = await mkdtemp(join(tmpdir(), 'f117-append-preference-'));
saveMessageDispositionPreference(appendPreferenceRoot, { scope: 'global', disposition: 'continue_current' });
after(() => rm(appendPreferenceRoot, { recursive: true, force: true }));
let sequence = 0;

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Queue progress did not converge');
}

function createHarness({ projectRoot = appendPreferenceRoot, autoDrain = false } = {}) {
  let processor;
  const admissionNotifications = [];
  const messageStore = new MessageStore();
  const invocationTracker = new InvocationTracker();
  // This Append fixture starts at an active parent before source admission.
  for (const target of ['opus', 'codex'])
    invocationTracker.start('thread-1', target, 'user-1', [target], 'parent-phase-m');
  const queue = new InvocationQueue(undefined, {
    projectRoot,
    resolveTargets: async (requested) => (requested.length ? [...requested] : ['opus']),
    ...(autoDrain
      ? {
          onAdmitted: ({ threadId, entries, message }) => {
            assert.ok(messageStore.getById(message.id), 'wake follows durable source commit');
            admissionNotifications.push(entries);
            void processor.requestDrain(threadId);
          },
        }
      : {}),
    invocationTracker,
    resolveCarrierCapability: () => ({
      provider: 'anthropic',
      carrier: 'claude_agent_sdk',
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    }),
  });
  const socketManager = { broadcastAgentMessage: mock.fn(), broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
  const deps = {
    queue,
    invocationTracker,
    invocationRecordStore: { create: mock.fn(), get: mock.fn(async () => null), update: mock.fn() },
    router: {
      resolveExplicitTargets: mock.fn(async (targets) => [...targets]),
      resolveConversationTargetsAtAdmission: mock.fn(async (targets) => [...targets]),
      routeExecution: mock.fn(async function* () {}),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager,
    messageStore,
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
  processor = new QueueProcessor(deps, { retryDeferral: { baseDelayMs: 60_000 } });
  return { ...deps, processor, admissionNotifications };
}

async function admit(harness, overrides = {}) {
  sequence += 1;
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: `phase-m-append-${sequence}`,
    content: `append body ${sequence}`,
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  const result = await harness.queue.send(
    harness.messageStore,
    canonicalTestMessageInput({
      threadId: 'thread-1',
      userId: queueInput.userId,
      catId: null,
      from: queueInput.from,
      content: queueInput.content,
      mentions: queueInput.targetCats,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      ...(overrides.visibility ? { visibility: overrides.visibility, whisperTo: overrides.whisperTo } : {}),
      ...(overrides.idempotencyKey ? { idempotencyKey: overrides.idempotencyKey } : {}),
      ...(['external', 'system'].includes(queueInput.from.kind)
        ? {
            source: overrides.messageSource ?? {
              connector: queueInput.from.connectorId ?? queueInput.from.service,
              label: 'policy-fixture',
            },
          }
        : {}),
    }),
    queueInput,
  );
  assert.equal(result.outcome, 'enqueued');
  return result;
}

function bindRun(harness, dispatch, targetId = 'opus') {
  const invocationId = `turn-phase-m-${sequence}-${targetId}`;
  const startedAt = Date.now();
  harness.invocationTracker.start('thread-1', targetId, 'user-1', [targetId], 'parent-phase-m');
  const response = harness.messageStore.append({
    from: { kind: 'agent', catId: targetId },
    userId: 'user-1',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    threadId: 'thread-1',
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  assert.equal(
    harness.invocationTracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId,
        invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt,
      },
      'parent-phase-m',
    ),
    true,
  );
  const releaseCarrier = harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', targetId, {
    invocationId,
    capabilities: { append: true, steer: true },
    handle: { provider: 'anthropic', carrier: 'claude_agent_sdk', threadId: 's', turnId: 't' },
    dispatch,
  });
  assert.equal(typeof releaseCarrier, 'function');
  return { invocationId, response, releaseCarrier };
}

async function append(harness, admitted, run) {
  return harness.processor.appendExactEntry({
    threadId: 'thread-1',
    userId: 'user-1',
    entryId: admitted.entry.id,
    expectedQueueRevision: harness.queue.snapshotRevision('thread-1', 'user-1'),
    expectedRuns: [{ targetId: 'opus', invocationId: run.invocationId, responseMessageId: run.response.id }],
  });
}

const deliveredEmits = (harness) =>
  harness.socketManager.emitToUser.mock.calls
    .filter((call) => call.arguments[1] === 'messages_delivered')
    .flatMap((call) => call.arguments[2].messageIds);
const activeInputs = (harness) => harness.invocationTracker.getActiveSlots('thread-1')[0].activeRun.inputMessageIds;

describe('common Queue default sending policy', () => {
  const sources = [
    { kind: 'user', userId: 'user-1' },
    { kind: 'agent', catId: 'codex' },
    { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } },
    { kind: 'system', service: 'scheduler' },
  ];
  for (const disposition of ['next_work', 'continue_current']) {
    for (const from of sources) {
      it(`${from.kind} uses the same ${disposition} default at admission`, async (t) => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'f117-policy-'));
        t.after(() => rm(projectRoot, { recursive: true, force: true }));
        saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition });
        const harness = createHarness({ projectRoot });
        const admitted = await admit(harness, { from });
        const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
        bindRun(harness, dispatch);
        await harness.processor.requestDrain('thread-1');
        assert.equal(dispatch.mock.calls.length, disposition === 'continue_current' ? 1 : 0);
        assert.equal(harness.router.routeExecution.mock.calls.length, 0);
        const queued = harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
        if (disposition === 'next_work') {
          assert.equal(queued.status, 'queued');
          assert.equal(
            queued.delivery.authorIntentByTarget.opus.requested,
            'next_work',
            'default is persisted at admission',
          );
        } else {
          assert.equal(queued, null);
        }
      });
    }
  }

  it('common admission uses thread over global over product', async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'f117-scopes-'));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    for (const phase of ['product', 'global', 'thread', 'removed_thread']) {
      if (phase === 'global')
        saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
      if (phase === 'thread')
        saveMessageDispositionPreference(projectRoot, {
          scope: 'thread',
          threadId: 'thread-1',
          disposition: 'next_work',
        });
      if (phase === 'removed_thread')
        saveMessageDispositionPreference(projectRoot, { scope: 'thread', threadId: 'thread-1', disposition: null });
      const harness = createHarness({ projectRoot });
      const admitted = await admit(harness);
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      bindRun(harness, dispatch);
      const expected = ['global', 'removed_thread'].includes(phase) ? 'continue_current' : 'next_work';
      assert.equal(admitted.entry.delivery.authorIntentByTarget.opus.requested, expected, phase);
      await harness.processor.requestDrain('thread-1');
      assert.equal(dispatch.mock.calls.length, expected === 'continue_current' ? 1 : 0, phase);
    }
  });

  for (const from of sources) {
    for (const explicit of ['next_work', 'continue_current']) {
      it(`${from.kind} explicit ${explicit} overrides the opposite default`, async (t) => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'f117-explicit-'));
        t.after(() => rm(projectRoot, { recursive: true, force: true }));
        saveMessageDispositionPreference(projectRoot, {
          scope: 'global',
          disposition: explicit === 'next_work' ? 'continue_current' : 'next_work',
        });
        const harness = createHarness({ projectRoot });
        const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
        bindRun(harness, dispatch);
        const admitted = await admit(harness, {
          from,
          authorIntentByCatId: {
            opus: {
              requested: explicit,
              ...(explicit === 'continue_current' ? { boundParentInvocationId: 'parent-phase-m' } : {}),
            },
          },
        });
        await harness.processor.requestDrain('thread-1');
        assert.equal(dispatch.mock.calls.length, explicit === 'continue_current' ? 1 : 0);
        if (explicit === 'next_work') {
          assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
        }
      });
    }

    it(`${from.kind} same-ID replay retains admission policy; changes affect only new messages`, async (t) => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'f117-replay-policy-'));
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      const harness = createHarness({ projectRoot });
      const overrides = { from, idempotencyKey: `policy-replay-${from.kind}`, content: 'same immutable source' };
      const admitted = await admit(harness, overrides);
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const otherDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      bindRun(harness, dispatch);
      bindRun(harness, otherDispatch, 'codex');
      saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
      const queuedReplay = await admit(harness, overrides);
      assert.equal(queuedReplay.message.id, admitted.message.id);
      assert.equal(queuedReplay.entry.delivery.authorIntentByTarget.opus.requested, 'next_work');
      await harness.processor.requestDrain('thread-1');
      assert.equal(dispatch.mock.calls.length, 0, 'changing default cannot rewrite an already queued strategy');
      const nextOverrides = { ...overrides, idempotencyKey: `${overrides.idempotencyKey}:new`, targetCats: ['codex'] };
      const next = await admit(harness, nextOverrides);
      assert.equal(next.entry.delivery.authorIntentByTarget.codex.requested, 'continue_current');
      await harness.processor.requestDrain('thread-1');
      assert.equal(otherDispatch.mock.calls.length, 1);
      saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'next_work' });
      if (from.kind === 'external' || from.kind === 'system') {
        const delivery = new PersistedQueueDelivery({
          messages: harness.messageStore,
          queue: harness.queue,
          progress: (entry, targetCatId) => harness.processor.progressOwnedCarrier(entry, targetCatId),
        });
        const deliveredReplay = await delivery.deliver({
          ownerUserId: 'user-1',
          threadId: 'thread-1',
          targetCatId: 'codex',
          from,
          idempotencyKey: nextOverrides.idempotencyKey,
          content: nextOverrides.content,
          source: { connector: from.connectorId ?? from.service, label: 'policy-fixture' },
        });
        assert.ok(['already_processing', 'terminal_owned'].includes(deliveredReplay.state));
        assert.equal(deliveredReplay.message.id, next.message.id);
      }
      await harness.processor.requestDrain('thread-1');
      assert.equal(otherDispatch.mock.calls.length, 1, 'new defaults cannot resurrect a retired source');
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', next.entry.id), null);
    });

    it(`${from.kind} busy unsupported target waits even when the default requests guidance`, async () => {
      const harness = createHarness();
      const admitted = await admit(harness, { from });
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      run.releaseCarrier();
      await harness.processor.requestDrain('thread-1');
      assert.equal(dispatch.mock.calls.length, 0);
      assert.equal(harness.router.routeExecution.mock.calls.length, 0);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
    });

    for (const disposition of ['next_work', 'continue_current']) {
      it(`${from.kind} idle target starts a fresh turn under ${disposition}`, async (t) => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'f117-idle-policy-'));
        t.after(() => rm(projectRoot, { recursive: true, force: true }));
        saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition });
        const harness = createHarness({ projectRoot });
        harness.invocationTracker.completeAll('thread-1', ['opus', 'codex']);
        harness.invocationRecordStore.create.mock.mockImplementation(async () => ({
          outcome: 'created',
          invocationId: 'fresh-policy-parent',
        }));
        await admit(harness, { from });
        await harness.processor.requestDrain('thread-1');
        await waitFor(() => harness.router.routeExecution.mock.calls.length === 1);
        assert.equal(harness.router.routeExecution.mock.calls.length, 1);
        assert.equal(harness.invocationRecordStore.create.mock.calls.length, 1);
      });
    }
  }
});

describe('delivery owns Append admission, without model-read state', () => {
  for (const from of [
    { kind: 'user', userId: 'user-1' },
    { kind: 'agent', catId: 'codex' },
    { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } },
    { kind: 'system', service: 'scheduler' },
  ]) {
    it(`one Queue drain appends ${from.kind} input without ingress-owned Append calls`, async () => {
      const harness = createHarness();
      const admitted = await admit(harness, { from });
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      await harness.processor.requestDrain('thread-1');
      assert.equal(dispatch.mock.calls.length, 1);
      assert.deepEqual(activeInputs(harness), [admitted.message.id]);
      const source = harness.messageStore.getById(admitted.message.id);
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
      assert.equal(harness.router.routeExecution.mock.calls.length, 0);
    });
  }

  it('keeps guidance bound while the same parent prepares its native dispatcher', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    await harness.processor.requestDrain('thread-1');
    const waiting = harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
    assert.equal(waiting.delivery.authorIntentByTarget.opus.fallbackAt, undefined);
    assert.equal(waiting.delivery.authorIntentByTarget.opus.boundParentInvocationId, 'parent-phase-m');
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    bindRun(harness, dispatch);
    await harness.processor.requestDrain('thread-1');
    assert.equal(dispatch.mock.calls.length, 1);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });

  for (const barrier of ['next_work', 'retry']) {
    it(`automatic Append respects a same-target ${barrier} barrier while another target progresses`, async () => {
      const harness = createHarness();
      const first = await admit(harness);
      if (barrier === 'next_work') {
        await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', first.entry.id, 'opus', {
          requested: 'next_work',
        });
      } else {
        harness.processor.retryDeferrals.defer('thread-1', first.entry.id);
      }
      const later = await admit(harness);
      const other = await admit(harness, { targetCats: ['codex'] });
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const otherDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      bindRun(harness, dispatch);
      bindRun(harness, otherDispatch, 'codex');
      await harness.processor.requestDrain('thread-1');
      assert.equal(dispatch.mock.calls.length, 0);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', first.entry.id).status, 'queued');
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', later.entry.id).status, 'queued');
      assert.equal(otherDispatch.mock.calls.length, 1);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', other.entry.id), null);
      harness.processor.retryDeferrals.forget(first.entry.id);
    });
  }

  it('pending native ACK holds its target while a different target appends', async () => {
    const harness = createHarness();
    const entered = deferred();
    const release = deferred();
    const first = await admit(harness);
    bindRun(harness, async () => {
      entered.resolve();
      await release.promise;
      return { accepted: true, handle: {} };
    });
    const firstDrain = harness.processor.requestDrain('thread-1');
    await entered.promise;
    const later = await admit(harness);
    const other = await admit(harness, { targetCats: ['codex'] });
    const otherDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    bindRun(harness, otherDispatch, 'codex');
    try {
      await Promise.race([
        harness.processor.requestDrain('thread-1'),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('native ACK blocked drain')), 1000);
          timer.unref();
        }),
      ]);
      await waitFor(() => otherDispatch.mock.calls.length === 1);
      assert.equal(otherDispatch.mock.calls.length, 1, 'other target advances before first ACK');
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', first.entry.id), null);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', later.entry.id).status, 'queued');
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', other.entry.id), null);
    } finally {
      release.resolve();
      await firstDrain;
    }
    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', later.entry.id) === null);
    assert.equal(
      harness.queue.getEntrySnapshot('thread-1', 'user-1', later.entry.id),
      null,
      'same-target input resumes on ACK',
    );
  });

  it('concurrent ingress drain signals append one source once', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    bindRun(harness, dispatch);
    await Promise.all(Array.from({ length: 4 }, () => harness.processor.requestDrain('thread-1')));
    assert.equal(dispatch.mock.calls.length, 1);
    assert.deepEqual(activeInputs(harness), [admitted.message.id]);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });

  it('one Queue drain preserves an explicit next-work intent while a reply runs', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
      requested: 'next_work',
    });
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    bindRun(harness, dispatch);
    await harness.processor.requestDrain('thread-1');
    assert.equal(dispatch.mock.calls.length, 0);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
    assert.deepEqual(activeInputs(harness), []);
  });

  it('Queue records cutover fallback without appending to a different parent', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
      requested: 'continue_current',
      boundParentInvocationId: 'closed-parent',
    });
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    bindRun(harness, dispatch);
    await harness.processor.requestDrain('thread-1');
    const row = harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
    assert.equal(row.status, 'queued');
    assert.equal(row.delivery.authorIntentByTarget.opus.fallbackReason, 'parent_terminal_before_exposure');
    assert.equal(typeof row.delivery.authorIntentByTarget.opus.fallbackAt, 'number');
    assert.equal(dispatch.mock.calls.length, 0);
    assert.deepEqual(activeInputs(harness), []);
  });

  for (const connector of ['github-wait', 'scheduled', 'other-connector']) {
    it(`producer ${connector} appends through its actual durable delivery path and does not replay`, async () => {
      const harness = createHarness();
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      const delivery = new PersistedQueueDelivery({
        messages: harness.messageStore,
        queue: harness.queue,
        progress: (entry, target) => harness.processor.progressOwnedCarrier(entry, target),
      });
      const carrier = {
        v: 1,
        waitId: 'task-pr-221',
        outcomeId: `wait:${connector}:221:merged`,
        ownerFence: { kind: 'containing_task', generation: 1 },
      };
      const input = {
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        targetCatId: 'opus',
        ownerAuthProvenance: 'strict',
        idempotencyKey: `producer-append-${connector}`,
        content: 'PR state: merged',
        source: { connector, label: connector, meta: { waitContinuationCarrier: carrier } },
        ...(connector === 'scheduled' ? { from: { kind: 'system', service: 'scheduler' } } : {}),
        waitContinuationCarrier: carrier,
      };
      const result = await delivery.deliver(input);
      assert.equal(result.state, 'terminal_owned', 'Queue retires the appended carrier before returning');
      assert.equal(dispatch.mock.calls.length, 1);
      assert.equal(result.message.lifecycle.kind, 'input');
      assert.deepEqual(activeInputs(harness), [result.message.id]);
      const source = harness.messageStore.getById(result.message.id);
      assert.equal(source.deliveryStatus, 'delivered');
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
      assert.deepEqual(source.source.meta.waitContinuationCarrier, carrier);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', result.entryId), null);
      const replay = await delivery.deliver(input);
      assert.equal(replay.message.id, result.message.id);
      assert.equal(dispatch.mock.calls.length, 1, 'same persisted producer identity must not append twice');
      const independent = await delivery.deliver({ ...input, idempotencyKey: `${input.idempotencyKey}:second` });
      assert.notEqual(independent.message.id, result.message.id, 'same text with another source remains independent');
      assert.equal(dispatch.mock.calls.length, 2);
      assert.deepEqual(activeInputs(harness), [result.message.id, independent.message.id]);
      assert.equal(harness.router.routeExecution.mock.calls.length, 0, 'no second turn is started');
    });
  }

  for (const boundary of ['unsupported', 'suppressed', 'private', 'owner_mismatch', 'bound_parent', 'system_pinned']) {
    it(`producer progress retains its queued carrier at the ${boundary} boundary`, async () => {
      const harness = createHarness();
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      if (boundary === 'unsupported') run.releaseCarrier();
      if (boundary === 'suppressed') harness.processor.suppressAutoResume('thread-1', 'opus');
      const queueOverrides = {
        from: { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } },
        ...(boundary === 'owner_mismatch' ? { userId: 'different-owner' } : {}),
        ...(boundary === 'system_pinned'
          ? { from: { kind: 'agent', catId: 'opus' }, sourceCategory: 'continuation' }
          : {}),
      };
      const admitted =
        boundary === 'private'
          ? await harness.queue.enqueueDurable(
              canonicalTestQueueInput({
                threadId: 'thread-1',
                userId: 'user-1',
                sourceId: 'private-producer',
                content: 'private work',
                targetCats: ['opus'],
                intent: 'execute',
                ...queueOverrides,
                kind: 'private_input',
              }),
            )
          : await admit(harness, queueOverrides);
      if (boundary === 'bound_parent') {
        await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
          requested: 'continue_current',
          boundParentInvocationId: 'different-parent',
        });
      }
      const progress = await harness.processor.progressOwnedCarrier(admitted.entry, 'opus');
      assert.equal(progress, boundary === 'suppressed' ? 'owned_deferred_suppressed' : 'owned_deferred_busy');
      assert.equal(dispatch.mock.calls.length, 0);
      assert.equal(
        harness.queue.getEntrySnapshot('thread-1', admitted.entry.owner.userId, admitted.entry.id).status,
        'queued',
      );
      assert.deepEqual(activeInputs(harness), []);
    });
  }

  it('auto Append honors a connector target choice and exact parent, preserving source identity', async () => {
    const harness = createHarness();
    const from = { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } };
    const carrier = {
      v: 1,
      waitId: 'task-pr-216',
      outcomeId: 'wait:pr:mindfn/clowder-ai:216:g1:matched',
      ownerFence: { kind: 'containing_task', generation: 1 },
    };
    const admitted = await admit(harness, {
      from,
      waitContinuationCarrier: carrier,
      messageSource: { connector: 'github-wait', label: 'GitHub Wait', meta: { waitContinuationCarrier: carrier } },
    });
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const run = bindRun(harness, dispatch);
    await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
      requested: 'continue_current',
      boundParentInvocationId: 'different-parent',
    });
    assert.equal(
      (
        await harness.processor.tryAutoAppendExactEntry({
          threadId: 'thread-1',
          userId: 'user-1',
          entryId: admitted.entry.id,
          targetCatId: 'opus',
        })
      ).outcome,
      'rejected',
    );
    assert.equal(dispatch.mock.calls.length, 0);
    const bound = await harness.queue.bindContinueCurrentIntentDurable(
      'thread-1',
      'user-1',
      admitted.entry.id,
      'opus',
      {
        requested: 'continue_current',
        boundParentInvocationId: harness.invocationTracker.getExecutionId('thread-1', 'opus'),
      },
    );
    assert.ok(bound);
    assert.deepEqual(bound.from, from);
    assert.deepEqual(bound.execution.waitContinuationCarrier, carrier);
    const result = await harness.processor.tryAutoAppendExactEntry({
      threadId: 'thread-1',
      userId: 'user-1',
      entryId: admitted.entry.id,
      targetCatId: 'opus',
    });
    assert.equal(result.outcome, 'appended');
    assert.equal(dispatch.mock.calls.length, 1);
    assert.equal(harness.invocationTracker.has('thread-1', 'opus'), true);
    assert.deepEqual((await harness.messageStore.getById(admitted.message.id)).from, from);
    assert.deepEqual(activeInputs(harness), [admitted.message.id]);
    assert.deepEqual(
      (await harness.messageStore.getById(admitted.message.id)).source.meta.waitContinuationCarrier,
      carrier,
    );
  });

  it('publishes and binds accepted input immediately even when the carrier never reports consumption', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const consumption = deferred();
    const run = bindRun(harness, async () => ({ accepted: true, handle: {}, consumption: consumption.promise }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.ok(deliveredEmits(harness).includes(source.id));
    const updates = harness.socketManager.emitToUser.mock.calls
      .filter((call) => call.arguments[1] === 'message_lifecycle_updated' && call.arguments[2].message.id === source.id)
      .map((call) => call.arguments[2].message);
    assert.ok(updates.length > 0);
    assert.deepEqual(
      updates.map((message) => message.timelineOrderAt),
      updates.map(() => source.timelineOrderAt),
      'lifecycle events must not overwrite a delivered input with its queued admission snapshot',
    );
    assert.deepEqual(activeInputs(harness), [source.id]);
    const response = await harness.messageStore.getById(run.response.id);
    assert.deepEqual(response.lifecycle.inputMessageIds, [source.id]);
    assert.equal(response.lifecycle.handedInputMessageIds, undefined);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    assert.equal(source.lifecycle.dispatchRefs[0].readAt, undefined);
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('keeps delivery terminal when a member fails before consuming the appended input', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: true, handle: {} }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');
    const terminal = harness.messageStore.commitLifecycleResponseTerminal(run.response.id, {
      invocationId: run.invocationId,
      status: 'failed',
      completedAt: Date.now() + 10,
      content: '成员处理失败',
      mentions: [],
      origin: 'stream',
    });
    assert.equal(terminal.kind, 'applied');
    await settleLifecycleResponseInputs(harness.messageStore, terminal.message, run.response.id);
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });

  it('automatic Append rejection after handoff compensates once and releases only its target', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const release = deferred();
    const run = bindRun(harness, async () => {
      await release.promise;
      return { accepted: false, reason: 'active_run_closed' };
    });
    await harness.processor.requestDrain('thread-1');
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
    assert.equal(
      harness.messageStore.getById(admitted.message.id).lifecycle.dispatchRefs[0].statusMessageId,
      run.response.id,
    );
    release.resolve();
    await waitFor(
      () => harness.messageStore.getById(admitted.message.id).lifecycle.dispatchRefs[0].phase === 'settled',
    );
    const source = harness.messageStore.getById(admitted.message.id);
    const ref = source.lifecycle.dispatchRefs[0];
    assert.notEqual(ref.statusMessageId, run.response.id);
    assert.equal(harness.messageStore.getById(ref.statusMessageId).lifecycle.kind, 'delivery_failure');
    assert.deepEqual(activeInputs(harness), []);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
    await harness.processor.requestDrain('thread-1');
    assert.equal(
      harness.messageStore
        .getByThread('thread-1', 100, 'user-1')
        .filter((message) => message.lifecycle?.kind === 'delivery_failure').length,
      1,
    );
  });

  it('publishes one exact failure when the carrier rejects delivery without resurrecting Queue work', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: false, reason: 'active_run_closed' }));
    assert.equal((await append(harness, admitted, run)).outcome, 'rejected');
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    const ref = source.lifecycle.dispatchRefs[0];
    assert.equal(ref.phase, 'settled');
    assert.notEqual(ref.statusMessageId, run.response.id);
    assert.equal((await harness.messageStore.getById(ref.statusMessageId)).lifecycle.kind, 'delivery_failure');
    assert.deepEqual(activeInputs(harness), []);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });
});

describe('existing ingress chains use common send admission and wake', () => {
  for (const policy of ['next_work', 'continue_current']) {
    for (const ingress of ['im', 'scheduler', 'notification', 'agent']) {
      it(`${ingress} ingress snapshots ${policy} and signals the common drain`, async (t) => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'f117-ingress-policy-'));
        t.after(() => rm(projectRoot, { recursive: true, force: true }));
        saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: policy });
        const harness = createHarness({ projectRoot, autoDrain: true });
        const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
        bindRun(harness, dispatch);
        const delivery = new PersistedQueueDelivery({
          messages: harness.messageStore,
          queue: harness.queue,
          progress: (entry, target) => harness.processor.progressOwnedCarrier(entry, target),
        });
        if (ingress === 'im') {
          const { ConnectorRouter } = await import('../dist/infrastructure/connectors/ConnectorRouter.js');
          const router = new ConnectorRouter({
            bindingStore: { getByExternal: async () => ({ threadId: 'thread-1', userId: 'user-1' }) },
            dedup: { isDuplicate: () => false },
            messageStore: harness.messageStore,
            persistedQueueDelivery: delivery,
            threadStore: { get: async () => ({ id: 'thread-1', projectPath: projectRoot }) },
            socketManager: { broadcastToRoom() {} },
            defaultUserId: 'user-1',
            defaultCatId: 'codex',
            log: { info() {}, warn() {}, error() {} },
          });
          await router.route('feishu', 'chat', 'same message body', `ingress-${ingress}-${policy}`);
        } else if (ingress === 'scheduler') {
          const { createDeliverFn } = await import('../dist/infrastructure/scheduler/delivery.js');
          await createDeliverFn({
            messageStore: harness.messageStore,
            socketManager: harness.socketManager,
            persistedQueueDelivery: delivery,
          })({
            userId: 'user-1',
            threadId: 'thread-1',
            targetCatId: 'opus',
            content: 'same message body',
            idempotencyKey: `ingress-${ingress}-${policy}`,
          });
        } else if (ingress === 'notification') {
          const { deliverConnectorMessage } = await import('../dist/infrastructure/email/deliver-connector-message.js');
          await deliverConnectorMessage(
            { delivery },
            {
              userId: 'user-1',
              threadId: 'thread-1',
              catId: 'opus',
              content: 'same message body',
              idempotencyKey: `ingress-${ingress}-${policy}`,
              source: { connector: 'github-wait', label: 'GitHub Wait' },
            },
          );
        } else {
          const { appendA2ASourceWithLedgerAdmission } = await import('../dist/routes/callback-a2a-trigger.js');
          await appendA2ASourceWithLedgerAdmission(
            { invocationQueue: harness.queue, messageStore: harness.messageStore },
            canonicalTestMessageInput({
              userId: 'user-1',
              threadId: 'thread-1',
              from: { kind: 'agent', catId: 'codex' },
              content: 'same message body',
              mentions: ['opus'],
              timestamp: Date.now(),
              idempotencyKey: `ingress-${ingress}-${policy}`,
            }),
            {
              plan: { acceptedTargetCats: ['opus'] },
              ownerAuthProvenance: 'strict',
              onQueueEntriesAdmitted: () =>
                assert.equal(harness.admissionNotifications.length, 0, 'consumer hooks precede drain notification'),
            },
          );
        }
        assert.equal(harness.admissionNotifications.length, 1);
        const [admission] = harness.admissionNotifications[0];
        assert.deepEqual(admission.targets, ['opus'], 'IM own fallback must not override the common send target');
        assert.equal(admission.delivery.authorIntentByTarget.opus.requested, policy);
        if (policy === 'continue_current') {
          await waitFor(() => dispatch.mock.calls.length === 1);
          assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admission.id), null);
        } else {
          assert.equal(dispatch.mock.calls.length, 0);
          assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admission.id).status, 'queued');
        }
      });
    }
  }
});

it('automatic Append delivers a whisper only to its authorized active recipient', async () => {
  const harness = createHarness();
  const opusDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
  const codexDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
  bindRun(harness, opusDispatch, 'opus');
  bindRun(harness, codexDispatch, 'codex');
  const admitted = await admit(harness, { visibility: 'whisper', whisperTo: ['opus'] });
  await harness.processor.requestDrain('thread-1');
  assert.equal(opusDispatch.mock.calls.length, 1);
  assert.equal(codexDispatch.mock.calls.length, 0);
  assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
});
for (const automatic of [true, false]) {
  it(`legacy misrouted whisper is rejected before native Append: automatic=${automatic}`, async () => {
    const harness = createHarness();
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const run = bindRun(harness, dispatch, 'codex');
    const source = harness.messageStore.append(
      canonicalTestMessageInput({
        threadId: 'thread-1',
        userId: 'user-1',
        catId: null,
        content: 'private legacy row',
        mentions: ['opus'],
        visibility: 'whisper',
        whisperTo: ['opus'],
        deliveryStatus: 'queued',
        timestamp: Date.now(),
      }),
    );
    const admitted = await harness.queue.enqueueExistingMessageDurable(
      harness.messageStore,
      source.id,
      canonicalTestQueueInput({
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        content: source.content,
        targetCats: ['codex'],
        intent: 'execute',
      }),
    );
    const result = automatic
      ? await harness.processor.tryAutoAppendExactEntry({
          threadId: 'thread-1',
          userId: 'user-1',
          entryId: admitted.entry.id,
          targetCatId: 'codex',
        })
      : await harness.processor.appendExactEntry({
          threadId: 'thread-1',
          userId: 'user-1',
          entryId: admitted.entry.id,
          expectedQueueRevision: harness.queue.snapshotRevision('thread-1', 'user-1'),
          expectedRuns: [{ targetId: 'codex', invocationId: run.invocationId, responseMessageId: run.response.id }],
        });
    assert.equal(result.outcome, 'rejected');
    assert.equal(dispatch.mock.calls.length, 0);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
    assert.equal(harness.messageStore.getById(run.response.id).lifecycle.inputMessageIds.length, 0);
  });
}
