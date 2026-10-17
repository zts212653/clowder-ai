import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';

import {
  buildDeliveryPresentation,
  createLifecycleDelivery,
  lifecycleIdFor,
} from '../dist/domains/messaging/lifecycle-delivery.js';
import { createSubscriptionDelivery } from '../dist/domains/messaging/subscription-delivery.js';

test('one presentation builder preserves legacy identity and omits absent metadata', () => {
  assert.deepEqual(
    buildDeliveryPresentation(
      'thread-1234567890',
      { kind: 'cat', id: 'cat-1', displayName: '砚砚' },
      {
        threadTitle: 'The thread',
        deepLinkUrl: 'https://example.test/thread/thread-1234567890',
      },
    ),
    {
      actor: { displayName: '砚砚', emoji: '🐱' },
      thread: { shortId: 'thread-12345678', title: 'The thread' },
      deepLinkUrl: 'https://example.test/thread/thread-1234567890',
    },
  );
  assert.deepEqual(buildDeliveryPresentation('thread-1', { kind: 'user', id: 'owner-1', displayName: 'lang' }), {
    actor: { displayName: 'lang', emoji: '👤' },
    thread: { shortId: 'thread-1' },
  });
  assert.deepEqual(buildDeliveryPresentation('thread-1', { kind: 'plugin', id: 'plugin-1' }), {
    actor: { displayName: 'plugin-1', emoji: '🔌' },
    thread: { shortId: 'thread-1' },
  });
  for (const actor of [
    { kind: 'user', id: 'owner-1', displayName: 'lang' },
    { kind: 'plugin', id: 'plugin-1' },
  ]) {
    assert.equal(
      validateMessagingRowInput('host.messaging.lifecycle', {
        lifecycleId: 'lifecycle_test',
        deliveryId: 'delivery_test',
        threadId: 'thread-1',
        state: 'started',
        presentation: buildDeliveryPresentation('thread-1', actor),
      }).valid,
      true,
      `${actor.kind} presentation must pass the contract`,
    );
  }
});

test('lifecycle events share the thread delivery queue and retain stable ids', async () => {
  const calls = [];
  let tail = Promise.resolve();
  const delivery = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'subscriber-1', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => {
      const current = tail.then(operation);
      tail = current.catch(() => undefined);
      return current;
    },
    drain: async () => calls.push({ state: 'message' }),
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-1');
  await delivery.onClosureCatchingUp('thread-1', 'cat-1', 'invocation-1');
  await delivery.onStreamEnd('thread-1', '', 'invocation-1');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-1');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-1');
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-1');
  assert.deepEqual(
    calls.map((call) => call.state),
    ['started', 'catching_up', 'catching_up', 'blocked', 'message', 'settled'],
  );
  assert.equal(calls[1].deliveryId === calls[2].deliveryId, false);
  assert.equal(new Set(calls.filter((call) => call.lifecycleId).map((call) => call.lifecycleId)).size, 1);
  assert.equal(calls[0].threadId, 'thread-1');
  assert.ok(calls.filter((call) => call.lifecycleId).every((call) => call.threadId === 'thread-1'));
  assert.ok(
    calls
      .filter((call) => call.lifecycleId)
      .every((call) => validateMessagingRowInput('host.messaging.lifecycle', call).valid),
  );
  assert.equal(calls.at(-1).chainDone, true);
  assert.equal(calls.at(-1).outcome, 'failed');
});

test('blocked carries the presentation deep link and settles failed even when invocation status succeeded', async () => {
  const events = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'subscriber', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      events.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({
      actor: { displayName: 'Cat', emoji: '🐱' },
      thread: { shortId: 'thread-1' },
      deepLinkUrl: 'https://example.test/thread/thread-1',
    }),
  });
  await delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-blocked');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-blocked');
  assert.equal(events[1].recoveryUrl, events[0].presentation.deepLinkUrl);
  assert.equal(events[2].outcome, 'failed');
});

test('unsupported subscribers are skipped; R1 rejection is audited once without retry', async () => {
  const attempts = [];
  const errors = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => [
      { subscriberId: 'unsupported', method: 'fixture.lifecycle', wire: false },
      { subscriberId: 'supported', method: 'fixture.lifecycle', wire: false },
    ],
    supportsAction: (subscriber) => subscriber === 'supported',
    invoke: async (subscriber, _method, input) => {
      attempts.push({ subscriber, input });
      throw Object.assign(new Error('out of order'), { code: 'LIFECYCLE_OUT_OF_ORDER' });
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
    onError: (fields) => errors.push(fields),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-2');
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-2');
  await delivery.notifyDeliveryBatchDone('thread-1', false, 'failed', 'invocation-2');
  assert.deepEqual(
    attempts.map(({ input }) => input.state),
    ['started', 'settled'],
  );
  assert.deepEqual(
    errors.map((error) => error.errorKind),
    ['LIFECYCLE_OUT_OF_ORDER', 'LIFECYCLE_OUT_OF_ORDER'],
  );
  assert.equal(attempts.at(-1).input.outcome, 'failed');
  assert.equal(attempts.at(-1).input.chainDone, false);
});

test('a stalled lifecycle action is bounded and audited once', async () => {
  const errors = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'stalled', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async () => new Promise(() => undefined),
    actionTimeoutMs: 5,
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
    onError: (fields) => errors.push(fields),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-stalled');
  assert.deepEqual(
    errors.map((error) => error.errorKind),
    ['TIMEOUT'],
  );
});

test('an idle un-settled lifecycle is evicted on the next hook without inventing settled', async () => {
  let now = 0;
  const events = [];
  const delivery = createLifecycleDelivery({
    now: () => now,
    subscribers: () => [{ subscriberId: 'subscriber', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      events.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'stale');
  now = 30 * 60_000;
  await delivery.onStreamStart('thread-1', 'cat-1', 'active');
  now = 60 * 60_000 - 1;
  await delivery.onStreamChunk('thread-1', 'still active', 'active');
  now = 60 * 60_000 + 1;
  await delivery.cleanupPlaceholders('thread-1', 'active');
  assert.equal(delivery.invocations.has('stale'), false);
  assert.equal(delivery.invocations.has('active'), true);
  assert.deepEqual(
    events.map(({ state }) => state),
    ['started', 'started'],
  );
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'stale');
  await delivery.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'active');
  assert.deepEqual(
    events.map(({ state }) => state),
    ['started', 'started', 'settled'],
  );
});

test('concurrent start and blocked keep started before blocked', async () => {
  const calls = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'subscriber', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input.state);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } };
    },
  });
  await Promise.all([
    delivery.onStreamStart('thread-1', 'cat-1', 'invocation-3'),
    delivery.onClosureBlocked('thread-1', 'cat-1', 'needs_user', 'invocation-3'),
  ]);
  assert.deepEqual(calls, ['started', 'blocked']);
  await assert.rejects(delivery.onClosureBlocked('another-thread', 'cat-1', 'needs_user', 'invocation-3'));
});

test('started reserves the thread tail before asynchronous presentation lookup', async () => {
  const calls = [];
  let releasePresentation;
  let tail = Promise.resolve();
  const enqueueThread = async (_threadId, operation) => {
    const current = tail.then(operation);
    tail = current.catch(() => undefined);
    return current;
  };
  const lifecycle = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'subscriber', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      calls.push(input.state);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread,
    drain: async () => undefined,
    presentation: () =>
      new Promise((resolve) => {
        releasePresentation = resolve;
      }),
  });

  const started = lifecycle.onStreamStart('thread-1', 'cat-1', 'invocation-slow-presentation');
  const message = enqueueThread('thread-1', async () => {
    calls.push('message');
  });
  releasePresentation({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } });
  await Promise.all([started, message]);
  assert.deepEqual(calls, ['started', 'message']);
});

test('canceled_by_user maps to cancelled rather than completed', async () => {
  const events = [];
  const delivery = createLifecycleDelivery({
    subscribers: () => [{ subscriberId: 'subscriber', method: 'fixture.lifecycle', wire: false }],
    supportsAction: () => true,
    invoke: async (_subscriber, _method, input) => {
      events.push(input);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await delivery.onStreamStart('thread-1', 'cat-1', 'invocation-cancelled');
  await delivery.notifyDeliveryBatchDone('thread-1', false, 'canceled_by_user', 'invocation-cancelled');
  assert.equal(events.at(-1).outcome, 'cancelled');
  assert.equal(events.at(-1).chainDone, false);
});

test('a published final envelope is delivered between lifecycle started and settled with its lifecycleId', async () => {
  const calls = [];
  let acked = false;
  const event = {
    type: 'message.publish',
    eventId: 'event-1',
    envelope: {
      messageId: 'message-1',
      threadId: 'thread-1',
      actor: { kind: 'cat', id: 'cat-1' },
      payload: { provenance: { epistemicStatus: 'observation' }, elements: [] },
    },
  };
  const delivery = createSubscriptionDelivery({
    presentation: async (threadId, actor) => buildDeliveryPresentation(threadId, { ...actor, displayName: '砚砚' }),
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-1' }),
      read: async () =>
        acked ? { events: [], ackToken: null, stale: false } : { events: [event], ackToken: 'ack-1', stale: false },
      ack: async () => {
        acked = true;
      },
    },
    resolveInvocationId: async () => 'invocation-final',
    delivery: {
      invoke: async (_subscriber, method, input) => {
        calls.push({ method, input });
        return { deliveryId: input.deliveryId };
      },
      deliver: async () => {
        throw new Error('unexpected legacy delivery');
      },
    },
  });
  await delivery.register({
    subscriberId: 'subscriber',
    threadId: 'thread-1',
    handleId: 'handle-1',
    method: 'bridge.deliver',
    lifecycleMethod: 'bridge.lifecycle',
    presentationVersion: 'v1',
  });
  const lifecycle = createLifecycleDelivery({
    subscribers: (threadId) => delivery.lifecycleTargetsForThread(threadId),
    supportsAction: () => true,
    invoke: async (subscriber, method, input) => {
      calls.push({ subscriber, method, input });
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: (threadId, operation) => delivery.enqueueThread(threadId, operation),
    drain: (threadId) => delivery.drain(threadId),
    presentation: async (threadId, catId) =>
      buildDeliveryPresentation(threadId, { kind: 'cat', id: catId, displayName: '砚砚' }),
  });
  await lifecycle.onStreamStart('thread-1', 'cat-1', 'invocation-final');
  await lifecycle.onStreamEnd('thread-1', '', 'invocation-final');
  await lifecycle.notifyDeliveryBatchDone('thread-1', true, 'succeeded', 'invocation-final');
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['bridge.lifecycle', 'bridge.deliver', 'bridge.lifecycle'],
  );
  assert.deepEqual(
    calls.map(({ input }) => input.state ?? 'message'),
    ['started', 'message', 'settled'],
  );
  assert.equal(calls[1].input.lifecycleId, lifecycleIdFor('invocation-final'));
  assert.deepEqual(calls[1].input.presentation, calls[0].input.presentation);
});

test('legacy method subscribers receive exactly their frozen three-key input', async () => {
  const calls = [];
  let acked = false;
  const delivery = createSubscriptionDelivery({
    presentation: async (threadId, actor) => buildDeliveryPresentation(threadId, actor),
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-legacy-method' }),
      read: async () =>
        acked
          ? { events: [], ackToken: null, stale: false }
          : {
              events: [
                {
                  type: 'message.publish',
                  eventId: 'event-legacy-method',
                  envelope: {
                    messageId: 'message-legacy-method',
                    threadId: 'thread-1',
                    actor: { kind: 'cat', id: 'cat-1' },
                    payload: { elements: [] },
                  },
                },
              ],
              ackToken: 'ack-legacy-method',
              stale: false,
            },
      ack: async () => {
        acked = true;
      },
    },
    resolveInvocationId: async () => 'invocation-legacy-method',
    delivery: {
      deliver: async () => {
        throw new Error('unexpected frozen delivery');
      },
      invoke: async (_subscriber, _method, input) => {
        assert.deepEqual(Object.keys(input).sort(), ['deliveryId', 'envelope', 'threadId']);
        calls.push(input);
        return { deliveryId: input.deliveryId };
      },
    },
  });
  await delivery.register({
    subscriberId: 'legacy-package',
    threadId: 'thread-1',
    handleId: 'handle-legacy-method',
    method: 'legacy.outbound',
  });
  await delivery.drain('thread-1');
  assert.equal(calls.length, 1);
});

test('the frozen host.messaging.deliver row also receives the final message lifecycleId', async () => {
  const delivered = [];
  let acked = false;
  const delivery = createSubscriptionDelivery({
    presentation: async (threadId, actor) => buildDeliveryPresentation(threadId, { ...actor, displayName: '砚砚' }),
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-legacy' }),
      read: async () =>
        acked
          ? { events: [], ackToken: null, stale: false }
          : {
              events: [
                {
                  type: 'message.publish',
                  eventId: 'event-legacy',
                  envelope: {
                    messageId: 'message-legacy',
                    threadId: 'thread-1',
                    actor: { kind: 'cat', id: 'cat-1' },
                    payload: { elements: [] },
                  },
                },
              ],
              ackToken: 'ack-legacy',
              stale: false,
            },
      ack: async () => {
        acked = true;
      },
    },
    resolveInvocationId: async () => 'invocation-legacy',
    delivery: {
      deliver: async (_subscriber, input) => {
        delivered.push(input);
        return { deliveryId: input.deliveryId };
      },
    },
  });
  await delivery.register({
    subscriberId: 'external',
    threadId: 'thread-1',
    handleId: 'handle-legacy',
    lifecycleMethod: 'host.messaging.lifecycle',
    presentationVersion: 'v1',
  });
  await delivery.drain('thread-1');
  assert.equal(delivered[0].lifecycleId, lifecycleIdFor('invocation-legacy'));
  assert.deepEqual(delivered[0].presentation, {
    actor: { displayName: '砚砚', emoji: '🐱' },
    thread: { shortId: 'thread-1' },
  });
});

test('wire lifecycle registration invokes the frozen Host method even when manifest declares a custom action', async () => {
  const calls = [];
  const subscription = createSubscriptionDelivery({
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
    messaging: {
      subscribe: async () => ({ subscriptionId: 'sub-wire' }),
      read: async () => ({ events: [], ackToken: null, stale: false }),
      ack: async () => undefined,
    },
    delivery: { deliver: async () => ({ deliveryId: 'unused' }) },
  });
  await subscription.register({
    subscriberId: 'wire-subscriber',
    threadId: 'thread-1',
    handleId: 'handle-wire',
    lifecycleMethod: 'connector.customLifecycle',
  });
  const lifecycle = createLifecycleDelivery({
    subscribers: (threadId) => subscription.lifecycleTargetsForThread(threadId),
    supportsAction: () => false,
    invoke: async (_subscriber, method, input) => {
      calls.push(method);
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: (threadId, operation) => subscription.enqueueThread(threadId, operation),
    drain: async () => undefined,
    presentation: async () => ({ actor: { displayName: 'Cat', emoji: '🐱' }, thread: { shortId: 'thread-1' } }),
  });
  await lifecycle.onStreamStart('thread-1', 'cat-1', 'invocation-wire');
  assert.deepEqual(calls, ['host.messaging.lifecycle']);
});

// P1.3 (W2-5c-p2): a v2 subscription's started carries the cat's receipt line every time (the old
// Feishu placeholder never showed a generic "thinking"), and the trigger message id when there is one.
function v2Fixture(triggerMessageId) {
  const calls = [];
  const lifecycle = createLifecycleDelivery({
    subscribers: () => [
      { subscriberId: 'feishu', method: 'feishu.lifecycle', wire: false, presentationVersion: 'v2' },
      { subscriberId: 'dingtalk', method: 'dingtalk.lifecycle', wire: false, presentationVersion: 'v1' },
    ],
    supportsAction: () => true,
    invoke: async (subscriber, _method, input) => {
      calls.push({ subscriber, input });
      return { deliveryId: input.deliveryId };
    },
    enqueueThread: async (_threadId, operation) => operation(),
    drain: async () => undefined,
    presentation: async (threadId, catId) =>
      buildDeliveryPresentation(threadId, { kind: 'cat', id: catId, displayName: '宪宪' }),
    triggerMessageId,
  });
  return { lifecycle, started: (subscriber) => calls.find((call) => call.subscriber === subscriber)?.input, calls };
}

const FALLBACK_RECEIPT_LINES = ['收到，马上处理。', '看到了，稍等。', '收到！'];

test('P1.3: a v2 started carries a receipt line and the trigger message id; a v1 started carries neither', async () => {
  const x = v2Fixture(async (invocationId) => (invocationId === 'invocation-1' ? 'msg-trigger-1' : undefined));

  await x.lifecycle.onStreamStart('thread-1', 'cat-without-own-lines', 'invocation-1');

  const v2 = x.started('feishu');
  assert.ok(FALLBACK_RECEIPT_LINES.includes(v2.placeholderLine), 'a cat without its own lines gets a fallback line');
  assert.equal(v2.replyTo, 'msg-trigger-1');
  const v1 = x.started('dingtalk');
  assert.equal('placeholderLine' in v1, false);
  assert.equal('replyTo' in v1, false);
  for (const { input } of x.calls)
    assert.equal(validateMessagingRowInput('host.messaging.lifecycle', input).valid, true);
});

test('P1.3: without a trigger message, or when the lookup fails, a v2 started still goes out without replyTo', async () => {
  for (const lookup of [async () => undefined, async () => Promise.reject(new Error('registry down'))]) {
    const x = v2Fixture(lookup);

    await x.lifecycle.onStreamStart('thread-1', 'opus', 'invocation-2');

    const v2 = x.started('feishu');
    assert.equal(typeof v2.placeholderLine, 'string');
    assert.ok(v2.placeholderLine.length > 0);
    assert.equal('replyTo' in v2, false);
    assert.equal(validateMessagingRowInput('host.messaging.lifecycle', v2).valid, true);
  }
});
