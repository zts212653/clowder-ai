/**
 * F202 Train C1 — Host-driven outbound: thread activity reaches a subscribing plugin.
 *
 * THE SHAPE operator settled: the plugin declares which thread it wants and which of its own
 * methods to call; when the thread produces a message the Host finds the subscribers and calls
 * that method; whatever the plugin then does with it (relay to Feishu, or anything else) is
 * closed inside the plugin. Nothing here knows what an IM connector is.
 *
 * WHY THE DRIVER LIVES IN THE HOST. The durable half of this already exists and is already
 * published — subscribe/read/ack carry the cursor, the replay floor and the INV-9 stale signal.
 * Putting the consume loop in the Host means one implementation with one set of failure
 * semantics; asking every plugin author to write their own read/ack loop would mean N copies
 * and N ways to drop a message. So the driver is a Host-side consumer of the Host's own
 * published API, and the only surface this adds is the direction itself: calling a plugin.
 *
 * WHAT THE TESTS PIN. Delivery must be at-least-once against a failing plugin (case 2) — the
 * cursor may only advance on an accepted call, because a connector that was briefly down must
 * come back to its messages rather than discover a hole. And it must not redeliver what was
 * accepted (case 3), because a duplicate outbound is a duplicate message in someone's chat.
 *
 * STATUS when written: RED — `domains/messaging/subscription-delivery.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { validateMessagingRowInput } from '@clowder-ai/plugin-contract';

let createMessagingDomain;
let createSubscriptionDelivery;
let MessageStore;

let messaging;
let delivery;
let calls;
let attempts;
/** Errors to inject into successive deliver() calls; one entry consumed per attempt. */
let deliveryFailures;

const THREAD_ID = 'thread-1';
const USER_ID = 'user-1';
const PRODUCER = { pluginInstanceId: 'inst-producer' };
const SUBSCRIBER_A = 'inst-feishu';
const SUBSCRIBER_B = 'inst-front-desk';

beforeEach(async () => {
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ createSubscriptionDelivery } = await import('../dist/domains/messaging/subscription-delivery.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));

  calls = [];
  attempts = [];
  deliveryFailures = [];
  messaging = createMessagingDomain({ messageStore: new MessageStore() });

  delivery = createSubscriptionDelivery({
    messaging,
    presentation: async (threadId, actor) => ({
      actor: { displayName: actor.id, emoji: actor.kind === 'cat' ? '🐱' : '🔌' },
      thread: { shortId: threadId },
    }),
    delivery: {
      async deliver(subscriberId, input) {
        attempts.push({ subscriberId, input });
        const failure = deliveryFailures.shift();
        if (failure) throw new Error(failure);
        calls.push({ subscriberId, input });
        return { deliveryId: input.deliveryId };
      },
    },
  });
});

async function subscribeHandle(pluginInstanceId) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId,
    threadId: THREAD_ID,
    userId: USER_ID,
    scope: { canSend: false, canSubscribe: true },
  });
  return handleId;
}

async function produce(text, idempotencyKey) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: PRODUCER.pluginInstanceId,
    threadId: THREAD_ID,
    userId: USER_ID,
    scope: { canSend: true, canSubscribe: false },
  });
  return messaging.send(PRODUCER, {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey,
    payload: {
      provenance: { epistemicStatus: 'user_intent' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
    },
  });
}

describe('F202 C1 — Host-driven subscription delivery', () => {
  test('case 1: a message on a subscribed thread uses the frozen Host delivery row', async () => {
    const handleId = await subscribeHandle(SUBSCRIBER_A);
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId,
      presentationVersion: 'v1',
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    assert.equal(calls.length, 1, 'the subscriber must be called exactly once');
    assert.equal(calls[0].subscriberId, SUBSCRIBER_A);
    assert.match(calls[0].input.deliveryId, /^delivery_[0-9a-f]{64}$/);
    assert.deepEqual(calls[0].input.threadHandle, { kind: 'thread_handle', handle: handleId });
    assert.equal(calls[0].input.envelope.threadId, THREAD_ID);
    assert.equal(calls[0].input.envelope.payload.elements[0].payload.text, 'hello');
    assert.deepEqual(Object.keys(calls[0].input).sort(), ['deliveryId', 'envelope', 'presentation', 'threadHandle']);
    assert.equal(validateMessagingRowInput('host.messaging.deliver', calls[0].input).valid, true);
  });

  test('case 2: a failing plugin does not lose the message — it is redelivered', async () => {
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
    });
    await produce('hello', 'k1');

    deliveryFailures.push('plugin is down');
    await delivery.drain(THREAD_ID).catch(() => {});
    assert.equal(calls.length, 0, 'the failed attempt must not count as delivered');

    await delivery.drain(THREAD_ID);
    assert.equal(calls.length, 1, 'the same message must come back after the plugin recovers');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].input.deliveryId, attempts[1].input.deliveryId, 'retry must keep its settlement key');
  });

  test('case 3: an accepted message is not redelivered', async () => {
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);
    await delivery.drain(THREAD_ID);

    assert.equal(calls.length, 1, 'a duplicate outbound would be a duplicate message in a chat');
  });

  test('case 4: every subscriber of the thread is called, and the Host knows no connector', async () => {
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_A),
    });
    await delivery.register({
      subscriberId: SUBSCRIBER_B,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(SUBSCRIBER_B),
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    const byInstance = new Map(calls.map((c) => [c.subscriberId, c.input]));
    assert.ok(byInstance.has(SUBSCRIBER_A));
    assert.ok(byInstance.has(SUBSCRIBER_B));
    assert.notEqual(
      byInstance.get(SUBSCRIBER_A).deliveryId,
      byInstance.get(SUBSCRIBER_B).deliveryId,
      'each subscriber gets its own settlement identity',
    );
    assert.equal(calls.length, 2);
  });

  test('case 5: a subscriber that is not a package is delivered identically', async () => {
    // The operator's generalisation: the live view is just another implementation of outbound.
    // Nothing in the driver may branch on what kind of subscriber this is.
    const LIVE_VIEW = 'ui:live-view';
    await delivery.register({
      subscriberId: LIVE_VIEW,
      threadId: THREAD_ID,
      handleId: await subscribeHandle(LIVE_VIEW),
    });
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].subscriberId, LIVE_VIEW);
    assert.equal(calls[0].input.envelope.threadId, THREAD_ID);
  });

  test('case 6: a mismatched delivery receipt keeps the cursor unacked', async () => {
    const handleId = await subscribeHandle(SUBSCRIBER_A);
    const rejected = [];
    delivery = createSubscriptionDelivery({
      messaging,
      presentation: async (threadId, actor) => ({
        actor: { displayName: actor.id, emoji: '🐱' },
        thread: { shortId: threadId },
      }),
      delivery: {
        async deliver(subscriberId, input) {
          rejected.push({ subscriberId, input });
          return { deliveryId: 'wrong-delivery' };
        },
      },
    });
    await delivery.register({ subscriberId: SUBSCRIBER_A, threadId: THREAD_ID, handleId });
    await produce('hello', 'k1');

    await assert.rejects(() => delivery.drain(THREAD_ID), /delivery receipt mismatch/);
    await assert.rejects(() => delivery.drain(THREAD_ID), /delivery receipt mismatch/);
    assert.equal(rejected.length, 2, 'the unacked envelope must be offered again');
    assert.equal(rejected[0].input.deliveryId, rejected[1].input.deliveryId);
  });

  test('case 7: concurrent drains of one thread serialize and deliver each event once', async () => {
    const handleId = await subscribeHandle(SUBSCRIBER_A);
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId,
    });
    await produce('hello', 'k1');

    let releaseFirst;
    const firstBlocked = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    delivery = createSubscriptionDelivery({
      messaging,
      presentation: async (threadId, actor) => ({
        actor: { displayName: actor.id, emoji: '🐱' },
        thread: { shortId: threadId },
      }),
      delivery: {
        async deliver(subscriberId, input) {
          attempts.push({ subscriberId, input });
          if (attempts.length === 1) await firstBlocked;
          calls.push({ subscriberId, input });
          return { deliveryId: input.deliveryId };
        },
      },
    });
    await delivery.register({
      subscriberId: SUBSCRIBER_A,
      threadId: THREAD_ID,
      handleId,
    });

    const first = delivery.drain(THREAD_ID);
    const second = delivery.drain(THREAD_ID);
    const deadline = Date.now() + 1_000;
    while (attempts.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.length, 1, 'the second drain must wait instead of reading the same unacked page');
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(calls.length, 1, 'serial drains must deliver the published event exactly once');
  });

  test('case 8: unregister removes only the named subscriber from the live delivery set', async () => {
    const handleA = await subscribeHandle(SUBSCRIBER_A);
    const handleB = await subscribeHandle(SUBSCRIBER_B);
    await delivery.register({ subscriberId: SUBSCRIBER_A, threadId: THREAD_ID, handleId: handleA });
    await delivery.register({ subscriberId: SUBSCRIBER_B, threadId: THREAD_ID, handleId: handleB });

    delivery.unregister(SUBSCRIBER_A, THREAD_ID);
    await produce('hello', 'k1');
    await delivery.drain(THREAD_ID);

    assert.deepEqual(
      calls.map((call) => call.subscriberId),
      [SUBSCRIBER_B],
    );
  });
});
