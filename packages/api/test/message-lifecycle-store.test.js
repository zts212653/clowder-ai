import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const processingLifecycle = {
  kind: 'response',
  orderKey: '0000000000100:response-1',
  from: { kind: 'agent', catId: 'opus' },
  invocationId: 'invocation-1',
  targetId: 'opus',
  inputEntryIds: ['entry-1'],
  inputMessageIds: ['message-1'],
  status: 'processing',
  startedAt: 100,
};

function terminalPatch(overrides = {}) {
  return {
    invocationId: 'invocation-1',
    status: 'completed',
    completedAt: 200,
    content: 'final body',
    contentBlocks: [{ type: 'text', text: 'final body' }],
    mentions: [],
    origin: 'stream',
    ...overrides,
  };
}

describe('MessageStore lifecycle response terminal CAS', () => {
  test('stores a delivery failure as a first-class History result and rejects malformed failure identity', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const failure = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: '没有可用成员可以处理这条消息。',
        mentions: [],
        timestamp: 101,
        lifecycle: {
          kind: 'delivery_failure',
          orderKey: '0000000000101:failure-1',
          from: { kind: 'system', service: 'message_delivery' },
          status: 'failed',
          sourceEntryId: 'entry-1',
          inputMessageId: 'message-1',
          requestedTargets: [],
          reason: 'no_available_target',
          createdAt: 101,
        },
      }),
    );

    assert.equal(failure.lifecycle.kind, 'delivery_failure');
    assert.equal(failure.lifecycle.inputMessageId, 'message-1');
    assert.throws(
      () =>
        store.append(
          canonicalTestMessageInput({
            userId: 'owner-1',
            threadId: 'thread-1',
            catId: null,
            content: 'invalid',
            mentions: [],
            timestamp: 102,
            lifecycle: { ...failure.lifecycle, reason: 'made_up_reason' },
          }),
        ),
      /lifecycle metadata is invalid/,
    );
  });

  test('replaces one processing bubble in place and replays only the exact terminal', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const processing = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: 100,
        lifecycle: processingLifecycle,
      }),
    );

    const applied = store.commitLifecycleResponseTerminal(processing.id, terminalPatch());
    assert.equal(applied.kind, 'applied');
    assert.equal(applied.message.id, processing.id);
    assert.equal(applied.message.content, 'final body');
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.equal(applied.message.lifecycle.completedAt, 200);

    const replayed = store.commitLifecycleResponseTerminal(processing.id, terminalPatch());
    assert.equal(replayed.kind, 'replayed');

    const conflicting = store.commitLifecycleResponseTerminal(
      processing.id,
      terminalPatch({ status: 'failed', completedAt: 201, reason: 'provider_failed' }),
    );
    assert.deepEqual(
      { kind: conflicting.kind, reason: conflicting.reason },
      { kind: 'conflict', reason: 'different_terminal' },
    );
    assert.equal(store.getById(processing.id).content, 'final body');
    assert.equal(store.getById(processing.id).lifecycle.status, 'completed');
  });

  test('atomically completes the same response bubble with its outbound wake admission', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const processing = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: 100,
        lifecycle: processingLifecycle,
      }),
    );
    const buildAdmission = (messageId) => ({
      version: 1,
      admissionId: `fanout:${messageId}`,
      ownerUserId: 'owner-1',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      targetCats: ['codex'],
      requestedTargetCats: ['codex'],
      callerCatId: 'opus',
      priority: 'normal',
      createdAt: 200,
    });

    const applied = store.commitLifecycleResponseTerminalWithQueueCustodyAdmission(
      processing.id,
      terminalPatch({ content: '@codex review', mentions: ['codex'] }),
      buildAdmission,
    );

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.message.id, processing.id, 'completed final must reuse its processing bubble');
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.deepEqual(applied.message.lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
    assert.equal(applied.message.queueCustodyAdmission.admissionId, `fanout:${processing.id}`);
    assert.equal(
      store.commitLifecycleResponseTerminalWithQueueCustodyAdmission(
        processing.id,
        terminalPatch({ content: '@codex review', mentions: ['codex'] }),
        buildAdmission,
      ).kind,
      'replayed',
    );
    assert.equal(store.getByThread('thread-1', 10, 'owner-1').length, 1, 'no copied Agent message may be appended');
  });

  test('fails closed on the wrong invocation and invalid terminal time', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const processing = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: 100,
        lifecycle: processingLifecycle,
      }),
    );

    const wrongOwner = store.commitLifecycleResponseTerminal(
      processing.id,
      terminalPatch({ invocationId: 'invocation-2' }),
    );
    assert.deepEqual(
      { kind: wrongOwner.kind, reason: wrongOwner.reason },
      { kind: 'conflict', reason: 'invocation_mismatch' },
    );

    const invalidTime = store.commitLifecycleResponseTerminal(processing.id, terminalPatch({ completedAt: 99 }));
    assert.deepEqual(
      { kind: invalidTime.kind, reason: invalidTime.reason },
      { kind: 'conflict', reason: 'invalid_terminal' },
    );
    assert.equal(store.getById(processing.id).lifecycle.status, 'processing');
  });

  test('rejects malformed lifecycle metadata at every append boundary', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const invalid = {
      userId: 'owner-1',
      threadId: 'thread-1',
      catId: 'opus',
      content: '',
      mentions: [],
      timestamp: 100,
      lifecycle: { ...processingLifecycle, completedAt: 101 },
    };
    for (const append of [
      (store) => store.append(invalid),
      (store) => store.appendIfThreadFrontier(invalid, null),
      (store) => store.appendAndObservePriorFrontier(invalid),
    ]) {
      const store = new MessageStore();
      assert.throws(() => append(store), /lifecycle metadata is invalid/);
      assert.equal(store.size, 0);
    }
  });
});

describe('MessageStore lifecycle input dispatch CAS', () => {
  test('atomically attaches one Queue input to every exact processing Active Run', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const input = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: 'append this',
        mentions: ['opus', 'codex'],
        timestamp: 90,
      }),
    );
    const response = (targetId, invocationId) =>
      store.append(
        canonicalTestMessageInput({
          userId: 'owner-1',
          threadId: 'thread-1',
          catId: targetId,
          content: '',
          mentions: [],
          timestamp: 100,
          lifecycle: {
            kind: 'response',
            orderKey: `100:${invocationId}`,
            from: { kind: 'agent', catId: targetId },
            invocationId,
            targetId,
            inputEntryIds: ['entry-old'],
            inputMessageIds: ['message-old'],
            status: 'processing',
            startedAt: 100,
          },
        }),
      );
    const opus = response('opus', 'turn-opus');
    const codex = response('codex', 'turn-codex');
    const admission = {
      threadId: 'thread-1',
      entryId: 'entry-append',
      inputMessageIds: [input.id],
      runs: [
        { targetId: 'opus', invocationId: 'turn-opus', responseMessageId: opus.id },
        { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id },
      ],
    };

    const applied = store.commitLifecycleAppendAdmission(admission);
    assert.equal(applied.kind, 'applied');
    assert.deepEqual(store.getById(input.id).lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id },
      { targetId: 'codex', phase: 'dispatched', statusMessageId: codex.id },
    ]);
    assert.deepEqual(store.getById(opus.id).lifecycle.inputEntryIds, ['entry-old', 'entry-append']);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputMessageIds, ['message-old', input.id]);
    assert.equal(store.commitLifecycleAppendAdmission(admission).kind, 'replayed');

    const wrongRun = store.commitLifecycleAppendAdmission({
      ...admission,
      runs: [{ targetId: 'opus', invocationId: 'turn-stale', responseMessageId: opus.id }],
    });
    assert.deepEqual(wrongRun, { kind: 'conflict', reason: 'response_lifecycle_conflict' });

    const failure = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: 'codex carrier closed',
        mentions: [],
        timestamp: 110,
        lifecycle: {
          kind: 'delivery_failure',
          orderKey: '110:failure-codex',
          from: { kind: 'system', service: 'message_delivery' },
          status: 'failed',
          sourceEntryId: 'entry-append',
          inputMessageId: input.id,
          requestedTargets: ['codex'],
          reason: 'control_carrier_replaced',
          createdAt: 110,
        },
      }),
    );
    const rejection = {
      threadId: 'thread-1',
      entryId: 'entry-append',
      inputMessageIds: [input.id],
      failureMessageIds: [failure.id],
      run: { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id },
    };
    assert.equal(store.commitLifecycleAppendRejection(rejection).kind, 'applied');
    assert.deepEqual(store.getById(input.id).lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id },
      { targetId: 'codex', phase: 'settled', statusMessageId: failure.id },
    ]);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputEntryIds, ['entry-old']);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputMessageIds, ['message-old']);
    assert.equal(store.commitLifecycleAppendRejection(rejection).kind, 'replayed');
  });

  test('publishes agent speech with durable wake custody in the same append', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    let observedAppend;
    const store = new MessageStore({
      onAppend: (message) => {
        observedAppend = structuredClone(message);
      },
    });
    const source = store.appendWithQueueCustodyAdmission(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '@codex please review',
        mentions: ['codex'],
        timestamp: 90,
        origin: 'callback',
      }),
      (messageId) => ({
        version: 1,
        admissionId: `fanout:${messageId}`,
        ownerUserId: 'owner-1',
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        targetCats: ['codex'],
        requestedTargetCats: ['codex'],
        callerCatId: 'opus',
        priority: 'normal',
        createdAt: 90,
      }),
    );

    assert.equal(source.deliveryStatus, undefined);
    assert.equal(source.queueCustodyAdmission.admissionId, `fanout:${source.id}`);
    assert.deepEqual(source.lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
    assert.equal(source.lifecycle.kind, 'input');
    assert.deepEqual(source.from, { kind: 'agent', catId: 'opus' });
    assert.deepEqual(observedAppend, source, 'append listeners must never observe speech without its wake admission');
    assert.deepEqual(
      store.getByThread('thread-1', 10, 'owner-1').map((message) => message.id),
      [source.id],
    );
  });

  test('advances one target monotonically while preserving the exact response bubble', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const input = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: 'please inspect this',
        mentions: ['opus'],
        timestamp: 90,
      }),
    );
    const dispatchedPatch = {
      orderKey: '0000000000090:message-1',
      from: { kind: 'user', userId: 'owner-1' },
      targetId: 'opus',
      phase: 'dispatched',
      statusMessageId: 'response-1',
    };

    const dispatched = store.advanceLifecycleInputDispatch(input.id, dispatchedPatch);
    assert.equal(dispatched.kind, 'applied');
    assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: 'response-1' },
    ]);
    assert.equal(store.advanceLifecycleInputDispatch(input.id, dispatchedPatch).kind, 'replayed');

    const settled = store.advanceLifecycleInputDispatch(input.id, {
      ...dispatchedPatch,
      phase: 'settled',
    });
    assert.equal(settled.kind, 'applied');
    assert.deepEqual(settled.message.lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'settled', statusMessageId: 'response-1' },
    ]);
    assert.equal(
      store.advanceLifecycleInputDispatch(input.id, { ...dispatchedPatch, phase: 'settled' }).kind,
      'replayed',
    );
  });

  test('advances an assigned target on a completed response without replacing that response lifecycle', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const response = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '@codex please continue',
        mentions: ['codex'],
        timestamp: 100,
        lifecycle: {
          ...processingLifecycle,
          status: 'completed',
          completedAt: 100,
          dispatchRefs: [{ targetId: 'codex', phase: 'assigned' }],
        },
      }),
    );

    const dispatched = store.advanceLifecycleInputDispatch(response.id, {
      orderKey: processingLifecycle.orderKey,
      from: processingLifecycle.from,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: 'response-2',
    });
    assert.equal(dispatched.kind, 'applied');
    assert.equal(dispatched.message.lifecycle.kind, 'response');
    assert.equal(dispatched.message.lifecycle.invocationId, 'invocation-1');
    assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'dispatched', statusMessageId: 'response-2' },
    ]);
  });

  test('rejects skipped, conflicting, and regressing target transitions', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const input = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: 'please inspect this',
        mentions: ['opus'],
        timestamp: 90,
      }),
    );
    const base = {
      orderKey: '0000000000090:message-1',
      from: { kind: 'user', userId: 'owner-1' },
      targetId: 'opus',
      statusMessageId: 'response-1',
    };

    const skipped = store.advanceLifecycleInputDispatch(input.id, { ...base, phase: 'settled' });
    assert.deepEqual(
      { kind: skipped.kind, reason: skipped.reason },
      { kind: 'conflict', reason: 'invalid_transition' },
    );
    assert.equal(store.advanceLifecycleInputDispatch(input.id, { ...base, phase: 'dispatched' }).kind, 'applied');

    const wrongBubble = store.advanceLifecycleInputDispatch(input.id, {
      ...base,
      phase: 'settled',
      statusMessageId: 'response-2',
    });
    assert.deepEqual(
      { kind: wrongBubble.kind, reason: wrongBubble.reason },
      { kind: 'conflict', reason: 'status_message_mismatch' },
    );

    assert.equal(store.advanceLifecycleInputDispatch(input.id, { ...base, phase: 'settled' }).kind, 'applied');
    const regressed = store.advanceLifecycleInputDispatch(input.id, { ...base, phase: 'dispatched' });
    assert.deepEqual(
      { kind: regressed.kind, reason: regressed.reason },
      { kind: 'conflict', reason: 'invalid_transition' },
    );
  });
});

describe('MessageStore lifecycle pre-admission failure transaction', () => {
  test('keeps public agent speech visible and settles its assigned wake to the failure result', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const source = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '@codex please review',
        mentions: ['codex'],
        timestamp: 90,
        origin: 'callback',
      }),
    );
    const initialized = store.initializeQueueCustody(source.id, {
      version: 1,
      entryId: 'entry-wake',
      revision: 1,
      ownerUserId: 'owner-1',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      status: 'queued',
      allTargetCats: ['codex'],
      pendingTargetCats: ['codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      targetAttempts: [
        {
          id: 'entry-wake:codex:1',
          targetCatId: 'codex',
          sequence: 1,
          state: 'queued',
          createdAt: 90,
          updatedAt: 90,
        },
      ],
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 90,
      updatedAt: 90,
    });
    assert.equal(initialized.kind, 'initialized');

    const input = {
      sourceMessageId: source.id,
      expectedEntryId: 'entry-wake',
      expectedQueueCustodyRevision: 1,
      requestedTargets: ['codex'],
      reason: 'invalid_explicit_target',
      content: '消息未能送达：指定的接收对象当前无效。',
      failedAt: 100,
    };
    const applied = store.commitLifecyclePreAdmissionFailure(input);

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.inputMessage.deliveryStatus, undefined);
    assert.equal(applied.inputMessage.deliveredAt, undefined);
    assert.equal(applied.inputMessage.queueCustody, undefined);
    assert.equal(applied.inputMessage.lifecycle.kind, 'input');
    assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'settled', statusMessageId: applied.failureMessage.id },
    ]);
    assert.equal(applied.failureMessage.lifecycle.inputMessageId, source.id);
    assert.deepEqual(
      store.getByThread('thread-1').map((message) => message.id),
      [source.id, applied.failureMessage.id],
    );

    const replayed = store.commitLifecyclePreAdmissionFailure(input);
    assert.equal(replayed.kind, 'replayed');
    assert.equal(replayed.failureMessage.id, applied.failureMessage.id);
    assert.deepEqual(replayed.inputMessage.lifecycle.dispatchRefs, applied.inputMessage.lifecycle.dispatchRefs);
  });

  test('settles only policy-rejected wake targets while preserving accepted target custody', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const source = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '@codex @kimi please review',
        mentions: ['codex', 'kimi'],
        timestamp: 90,
      }),
    );
    const initialized = store.initializeQueueCustody(source.id, {
      version: 1,
      entryId: 'fanout:source',
      revision: 1,
      ownerUserId: 'owner-1',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      status: 'queued',
      allTargetCats: ['codex', 'kimi'],
      pendingTargetCats: ['codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      targetAttempts: [
        {
          id: 'fanout:source:codex:1',
          targetCatId: 'codex',
          sequence: 1,
          state: 'queued',
          createdAt: 90,
          updatedAt: 90,
        },
        {
          id: 'fanout:source:kimi:1',
          targetCatId: 'kimi',
          sequence: 1,
          state: 'failed',
          terminalReason: 'invocation_failed',
          createdAt: 90,
          updatedAt: 90,
        },
      ],
      failedByCatIds: ['kimi'],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 90,
      updatedAt: 90,
    });
    assert.equal(initialized.kind, 'initialized');

    const applied = store.commitLifecyclePreAdmissionFailure({
      sourceMessageId: source.id,
      expectedEntryId: 'fanout:source',
      expectedQueueCustodyRevision: 1,
      requestedTargets: ['codex', 'kimi'],
      failedTargets: ['kimi'],
      reason: 'invalid_explicit_target',
      content: '消息未能送达：部分指定接收对象当前无效。',
      failedAt: 100,
    });

    assert.equal(applied.kind, 'applied');
    assert.deepEqual(applied.inputMessage.queueCustody.pendingTargetCats, ['codex']);
    assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'assigned' },
      { targetId: 'kimi', phase: 'settled', statusMessageId: applied.failureMessage.id },
    ]);
    assert.deepEqual(applied.failureMessage.lifecycle.requestedTargets, ['kimi']);
  });

  test('atomically publishes the exact targetless input followed by one replay-safe failure result', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const source = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: null,
        content: '请继续',
        mentions: [],
        timestamp: 90,
        deliveryStatus: 'queued',
        queueCustody: {
          version: 1,
          entryId: 'entry-targetless',
          revision: 1,
          ownerUserId: 'owner-1',
          ownerAuthProvenance: 'strict',
          intent: 'execute',
          status: 'queued',
          allTargetCats: [],
          pendingTargetCats: [],
          notifiedByCatIds: [],
          seenByCatIds: [],
          seenInvocationIdByCatId: {},
          targetAttempts: [],
          failedByCatIds: [],
          handledByCatIds: [],
          priority: 'normal',
          createdAt: 90,
          updatedAt: 90,
        },
      }),
    );

    const input = {
      sourceMessageId: source.id,
      expectedEntryId: 'entry-targetless',
      expectedQueueCustodyRevision: 1,
      requestedTargets: [],
      reason: 'no_available_target',
      content: '没有可用成员可以处理这条消息。',
      contentBlocks: [{ type: 'text', text: '没有可用成员可以处理这条消息。' }],
      failedAt: 100,
    };
    const applied = store.commitLifecyclePreAdmissionFailure(input);

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.inputMessage.deliveryStatus, 'delivered');
    assert.equal(applied.inputMessage.queueCustody, undefined);
    assert.equal(applied.inputMessage.lifecycle.kind, 'input');
    assert.equal(applied.failureMessage.lifecycle.kind, 'delivery_failure');
    assert.equal(applied.failureMessage.lifecycle.inputMessageId, source.id);
    assert.deepEqual(
      store.getByThread('thread-1').map((message) => message.id),
      [source.id, applied.failureMessage.id],
    );

    const replayed = store.commitLifecyclePreAdmissionFailure(input);
    assert.equal(replayed.kind, 'replayed');
    assert.equal(replayed.failureMessage.id, applied.failureMessage.id);
    assert.equal(store.getByThread('thread-1').length, 2);

    const conflict = store.commitLifecyclePreAdmissionFailure({
      ...input,
      reason: 'invalid_explicit_target',
    });
    assert.deepEqual(
      { kind: conflict.kind, reason: conflict.reason },
      { kind: 'conflict', reason: 'different_failure' },
    );
  });
});
