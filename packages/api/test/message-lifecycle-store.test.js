import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

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
  test('settles the next-hop dispatch owned by a completed response source', async () => {
    const { MessageStore, commitLifecycleResponseFromAppendInput } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );
    const store = new MessageStore();
    const source = store.append(
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
          dispatchRefs: [],
        },
      }),
    );
    const child = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'codex',
        content: '',
        mentions: [],
        timestamp: 110,
        replyTo: source.id,
        lifecycle: {
          kind: 'response',
          orderKey: '0000000000110:child-response',
          from: { kind: 'agent', catId: 'codex' },
          invocationId: 'child-invocation',
          targetId: 'codex',
          inputEntryIds: ['entry-child'],
          inputMessageIds: [source.id],
          status: 'processing',
          startedAt: 110,
        },
      }),
    );
    assert.equal(
      store.advanceLifecycleInputDispatch(source.id, {
        orderKey: source.lifecycle.orderKey,
        producerInvocationId: source.lifecycle.producerInvocationId,
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: child.id,
        dispatchedAt: 110,
      }).kind,
      'applied',
    );

    await commitLifecycleResponseFromAppendInput(
      store,
      child.id,
      'child-invocation',
      { status: 'failed', completedAt: 120, reason: 'provider_failed' },
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'codex',
        content: 'Error: provider failed',
        mentions: [],
        timestamp: 110,
      }),
    );

    assert.deepEqual(store.getById(source.id).lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'settled', statusMessageId: child.id, dispatchedAt: 110 },
    ]);
    assert.equal(store.getById(child.id).replyTo, source.id, 'terminal commit must preserve exact source messageRef');
  });

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
    const processing = (
      await store.appendAndObservePriorFrontier(
        canonicalTestMessageInput({
          userId: 'owner-1',
          threadId: 'thread-1',
          catId: 'opus',
          content: '',
          mentions: [],
          timestamp: 100,
          lifecycle: processingLifecycle,
        }),
      )
    ).message;

    assert.deepEqual(await store.getByThreadAfter('thread-1', undefined, undefined, 'owner-1'), []);

    const applied = store.commitLifecycleResponseTerminal(processing.id, terminalPatch());
    assert.equal(applied.kind, 'applied');
    assert.equal(applied.message.id, processing.id);
    assert.equal(applied.message.content, 'final body');
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.equal(applied.message.lifecycle.completedAt, 200);
    assert.equal(typeof applied.message.visibilitySeq, 'number');
    assert.deepEqual(
      (await store.getByThreadAfter('thread-1', undefined, undefined, 'owner-1')).map((message) => message.id),
      [processing.id],
    );

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

  test('atomically completes the same response bubble with its outbound ledger admission', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const store = new MessageStore();
    const queue = new InvocationQueue();
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
    const input = {
      threadId: 'thread-1',
      userId: 'owner-1',
      kind: 'message_wake',
      from: { kind: 'agent', catId: 'opus' },
      ownerAuthProvenance: 'strict',
      content: '@codex review',
      intent: 'execute',
      targetCats: ['codex'],
      messageId: processing.id,
      sourceId: processing.id,
      sourceCategory: 'a2a',
      a2aTriggerMessageId: processing.id,
      autoExecute: true,
      priority: 'normal',
    };

    const applied = await queue.terminalizeResponseAndEnqueueDurable(
      store,
      processing.id,
      terminalPatch({ content: '@codex review', mentions: ['codex'] }),
      input,
    );

    assert.equal(applied.outcome, 'enqueued');
    assert.equal(applied.message.id, processing.id, 'completed final must reuse its processing bubble');
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.equal(applied.message.lifecycle.dispatchRefs, undefined);
    assert.equal(applied.entries.length, 1);
    assert.equal(applied.entries[0].payload.messageId, processing.id);
    assert.equal(
      (
        await queue.terminalizeResponseAndEnqueueDurable(
          store,
          processing.id,
          terminalPatch({ content: '@codex review', mentions: ['codex'] }),
          input,
        )
      ).deduped,
      true,
    );
    assert.equal(
      (
        await queue.terminalizeResponseAndEnqueueDurable(
          store,
          processing.id,
          terminalPatch({ content: '@codex review', mentions: ['codex'] }),
          input,
        )
      ).message.id,
      processing.id,
    );

    assert.ok(await queue.terminalizeEntryDurable('thread-1', 'owner-1', applied.entry.id));
    assert.equal(
      store.advanceLifecycleInputDispatch(processing.id, {
        orderKey: applied.message.lifecycle.orderKey,
        producerInvocationId: applied.message.lifecycle.producerInvocationId,
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: 'response-codex',
        dispatchedAt: 210,
      }).kind,
      'applied',
    );
    const afterDispatchReplay = await queue.terminalizeResponseAndEnqueueDurable(
      store,
      processing.id,
      terminalPatch({ content: '@codex review', mentions: ['codex'] }),
      input,
    );
    assert.equal(afterDispatchReplay.deduped, true);
    assert.deepEqual(afterDispatchReplay.entries, []);
    assert.equal(queue.list('thread-1', 'owner-1').length, 0, 'History terminal truth must prevent re-admission');
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
        { targetId: 'opus', invocationId: 'turn-opus', responseMessageId: opus.id, dispatchedAt: 101 },
        { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id, dispatchedAt: 102 },
      ],
    };

    const applied = store.commitLifecycleAppendAdmission(admission);
    assert.equal(applied.kind, 'applied');
    assert.deepEqual(store.getById(input.id).lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id, dispatchedAt: 101 },
      { targetId: 'codex', phase: 'dispatched', statusMessageId: codex.id, dispatchedAt: 102 },
    ]);
    assert.deepEqual(store.getById(opus.id).lifecycle.inputEntryIds, ['entry-old', 'entry-append']);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputMessageIds, ['message-old', input.id]);
    assert.equal(store.commitLifecycleAppendAdmission(admission).kind, 'replayed');

    const wrongRun = store.commitLifecycleAppendAdmission({
      ...admission,
      runs: [{ targetId: 'opus', invocationId: 'turn-stale', responseMessageId: opus.id, dispatchedAt: 103 }],
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
      { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id, dispatchedAt: 101 },
      { targetId: 'codex', phase: 'settled', statusMessageId: failure.id, dispatchedAt: 102 },
    ]);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputEntryIds, ['entry-old']);
    assert.deepEqual(store.getById(codex.id).lifecycle.inputMessageIds, ['message-old']);
    assert.equal(store.commitLifecycleAppendRejection(rejection).kind, 'replayed');
  });

  test('publishes agent speech with a durable ledger wake in the same append', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    let observedAppend;
    const store = new MessageStore({
      onAppend: (message) => {
        observedAppend = structuredClone(message);
      },
    });
    const queue = new InvocationQueue();
    const admission = await queue.appendAndEnqueueDurable(
      store,
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: '@codex please review',
        mentions: ['codex'],
        timestamp: 90,
        origin: 'callback',
      }),
      {
        userId: 'owner-1',
        threadId: 'thread-1',
        kind: 'message_wake',
        from: { kind: 'agent', catId: 'opus' },
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        content: '@codex please review',
        targetCats: ['codex'],
        sourceCategory: 'a2a',
        autoExecute: true,
        priority: 'normal',
      },
    );
    assert.equal(admission.outcome, 'enqueued');
    const source = admission.message;

    assert.equal(source.deliveryStatus, undefined);
    assert.equal(admission.entries.length, 1);
    assert.equal(admission.entries[0].payload.messageId, source.id);
    assert.deepEqual(source.lifecycle.dispatchRefs, []);
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
      dispatchedAt: 100,
    };

    const dispatched = store.advanceLifecycleInputDispatch(input.id, dispatchedPatch);
    assert.equal(dispatched.kind, 'applied');
    assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'dispatched', statusMessageId: 'response-1', dispatchedAt: 100 },
    ]);
    assert.equal(store.advanceLifecycleInputDispatch(input.id, dispatchedPatch).kind, 'replayed');

    const settled = store.advanceLifecycleInputDispatch(input.id, {
      ...dispatchedPatch,
      phase: 'settled',
    });
    assert.equal(settled.kind, 'applied');
    assert.deepEqual(settled.message.lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'settled', statusMessageId: 'response-1', dispatchedAt: 100 },
    ]);
    assert.equal(
      store.advanceLifecycleInputDispatch(input.id, { ...dispatchedPatch, phase: 'settled' }).kind,
      'replayed',
    );
  });

  test('records actual target dispatch on a completed response without replacing that response lifecycle', async () => {
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
          dispatchRefs: [],
        },
      }),
    );

    const dispatched = store.advanceLifecycleInputDispatch(response.id, {
      orderKey: processingLifecycle.orderKey,
      from: processingLifecycle.from,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: 'response-2',
      dispatchedAt: 105,
    });
    assert.equal(dispatched.kind, 'applied');
    assert.equal(dispatched.message.lifecycle.kind, 'response');
    assert.equal(dispatched.message.lifecycle.invocationId, 'invocation-1');
    assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'dispatched', statusMessageId: 'response-2', dispatchedAt: 105 },
    ]);
  });

  for (const status of ['failed', 'canceled', 'interrupted']) {
    test(`records downstream dispatch on a ${status} response without changing its own terminal status`, async () => {
      const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
      const store = new MessageStore();
      const response = store.append(
        canonicalTestMessageInput({
          userId: 'owner-1',
          threadId: 'thread-1',
          catId: 'bengal',
          content: 'provider returned its terminal result',
          mentions: [],
          timestamp: 100,
          lifecycle: {
            ...processingLifecycle,
            targetId: 'bengal',
            status,
            completedAt: 100,
            dispatchRefs: [],
          },
        }),
      );

      const dispatched = store.advanceLifecycleInputDispatch(response.id, {
        orderKey: processingLifecycle.orderKey,
        from: processingLifecycle.from,
        targetId: 'opus',
        phase: 'dispatched',
        statusMessageId: 'response-predecessor',
        dispatchedAt: 105,
      });

      assert.equal(dispatched.kind, 'applied');
      assert.equal(dispatched.message.lifecycle.kind, 'response');
      assert.equal(dispatched.message.lifecycle.status, status);
      assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
        {
          targetId: 'opus',
          phase: 'dispatched',
          statusMessageId: 'response-predecessor',
          dispatchedAt: 105,
        },
      ]);
    });
  }

  test('records actual target dispatch while the response source is still processing', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const response = store.append(
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        catId: 'opus',
        content: 'dispatching a multi-mention now',
        mentions: [],
        timestamp: 100,
        lifecycle: {
          ...processingLifecycle,
          dispatchRefs: [],
        },
      }),
    );

    const dispatched = store.advanceLifecycleInputDispatch(response.id, {
      orderKey: processingLifecycle.orderKey,
      from: processingLifecycle.from,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: 'response-2',
      dispatchedAt: 105,
    });
    assert.equal(dispatched.kind, 'applied');
    assert.equal(dispatched.message.lifecycle.kind, 'response');
    assert.equal(dispatched.message.lifecycle.status, 'processing');
    assert.deepEqual(dispatched.message.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'dispatched', statusMessageId: 'response-2', dispatchedAt: 105 },
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
      dispatchedAt: 100,
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
  test('keeps public agent speech visible and records its failed delivery result', async () => {
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
        lifecycle: {
          kind: 'input',
          orderKey: '90:entry-wake',
          dispatchRefs: [],
        },
      }),
    );

    const input = {
      sourceMessageId: source.id,
      expectedEntryId: 'entry-wake',
      requestedTargets: ['codex'],
      reason: 'invalid_explicit_target',
      content: '消息未能送达：指定的接收对象当前无效。',
      failedAt: 100,
    };
    const applied = store.commitLifecyclePreAdmissionFailure(input);

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.inputMessage.deliveryStatus, undefined);
    assert.equal(applied.inputMessage.deliveredAt, undefined);
    assert.equal(applied.inputMessage.queueCustody, undefined, 'History must not mirror Queue state');
    assert.equal(applied.inputMessage.lifecycle.kind, 'input');
    assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'settled', statusMessageId: applied.failureMessage.id, dispatchedAt: 100 },
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

  test('records one rejected target while leaving its pending sibling only in Queue', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const store = new MessageStore();
    const queue = new InvocationQueue();
    const admission = await queue.appendAndEnqueueDurable(
      store,
      canonicalTestMessageInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        from: { kind: 'user', userId: 'owner-1' },
        content: '@codex @kimi please review',
        mentions: ['codex', 'kimi'],
        timestamp: 90,
        deliveryStatus: 'queued',
      }),
      canonicalTestQueueInput({
        userId: 'owner-1',
        threadId: 'thread-1',
        from: { kind: 'user', userId: 'owner-1' },
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        content: '@codex @kimi please review',
        targetCats: ['codex', 'kimi'],
        intent: 'execute',
      }),
    );
    const source = admission.message;
    const kimiEntry = admission.entries.find((entry) => entry.targets.includes('kimi'));
    assert.ok(kimiEntry);

    const applied = store.commitLifecyclePreAdmissionFailure({
      sourceMessageId: source.id,
      expectedEntryId: kimiEntry.id,
      requestedTargets: ['kimi'],
      reason: 'invalid_explicit_target',
      content: '消息未能送达：指定的接收对象当前无效。',
      failedAt: 100,
    });

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.inputMessage.queueCustody, undefined, 'History must not mirror Queue state');
    assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
      { targetId: 'kimi', phase: 'settled', statusMessageId: applied.failureMessage.id, dispatchedAt: 100 },
    ]);
    assert.deepEqual(admission.entries[0].targets, ['codex', 'kimi']);
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
      }),
    );

    const input = {
      sourceMessageId: source.id,
      expectedEntryId: 'entry-targetless',
      requestedTargets: [],
      reason: 'no_available_target',
      content: '没有可用成员可以处理这条消息。',
      contentBlocks: [{ type: 'text', text: '没有可用成员可以处理这条消息。' }],
      failedAt: 100,
    };
    const applied = store.commitLifecyclePreAdmissionFailure(input);

    assert.equal(applied.kind, 'applied');
    assert.equal(applied.inputMessage.deliveryStatus, 'delivered');
    assert.equal(applied.inputMessage.queueCustody, undefined, 'History must not mirror Queue state');
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
