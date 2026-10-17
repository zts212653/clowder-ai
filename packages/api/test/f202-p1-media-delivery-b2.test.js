import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaEntitlementLedger, MemoryMediaEntitlementPort } from '../dist/domains/messaging/media-entitlements.js';
import { createSubscriptionDelivery } from '../dist/domains/messaging/subscription-delivery.js';

const HMR = `hmr_${'a'.repeat(32)}`;

function fixture({ selfEcho = false, fails = false, failGrant = false, hangs = false, actionTimeoutMs, actor } = {}) {
  const port = new MemoryMediaEntitlementPort();
  port.failNextSave = failGrant;
  const entitlements = new MediaEntitlementLedger(port, { now: () => 1000 });
  const envelope = {
    messageId: 'msg-1',
    threadId: 'thread-1',
    actor: actor ?? { kind: 'plugin', id: selfEcho ? 'subscriber' : 'producer' },
    payload: { elements: [{ elementId: 'media-1', kind: 'media_ref', payload: { type: 'file', reference: HMR } }] },
  };
  const event = { type: 'message.publish', eventId: 'event-1', sequence: 1, envelope };
  let cursor = 0;
  let called = 0;
  let receiptSawGrant = false;
  let otherSawGrant = false;
  const errors = [];
  const delivery = createSubscriptionDelivery({
    presentation: async (threadId, actor) => ({
      actor: { displayName: actor.id, emoji: '🐱' },
      thread: { shortId: threadId },
    }),
    entitlements,
    onError: (fields) => errors.push(fields),
    ...(actionTimeoutMs === undefined ? {} : { actionTimeoutMs }),
    messaging: {
      async subscribe() {
        return { subscriptionId: 'sub-1' };
      },
      async read() {
        return cursor === 0
          ? { events: [event], ackToken: 'ack-1', stale: false }
          : { events: [], ackToken: null, stale: false };
      },
      async ack() {
        cursor = 1;
      },
    },
    delivery: {
      async deliver(_instanceId, input) {
        called += 1;
        receiptSawGrant = await entitlements.isEntitled('subscriber', HMR);
        otherSawGrant = await entitlements.isEntitled('other-instance', HMR);
        if (hangs) return new Promise(() => {});
        if (fails) throw new Error('action failed');
        return { deliveryId: input.deliveryId };
      },
    },
  });
  return {
    port,
    entitlements,
    delivery,
    errors,
    async register() {
      await delivery.register({
        subscriberId: 'subscriber',
        threadId: 'thread-1',
        handleId: 'handle-1',
        ...(selfEcho ? { filter: { includeOwnMessages: true } } : {}),
      });
    },
    get called() {
      return called;
    },
    get receiptSawGrant() {
      return receiptSawGrant;
    },
    get otherSawGrant() {
      return otherSawGrant;
    },
  };
}

test('published hmr is readable only during delivery and revoke is durable before receipt', async () => {
  const x = fixture();
  await x.register();
  await x.delivery.drain('thread-1');
  assert.equal(x.called, 1);
  assert.equal(x.receiptSawGrant, true);
  assert.equal(await x.entitlements.isEntitled('subscriber', HMR), false);
  assert.equal((await x.port.load()).audit.at(-1).revokeReason, 'action_returned');
});

// W2-5b (6): Host-produced media is registered without an owner instance, so a cat reply's hmr is
// readable only through the grant a subscriber holds while its action runs.
test('Host-produced media in a cat reply is readable only through the delivery grant', async () => {
  const x = fixture({ actor: { kind: 'cat', id: 'opus' } });
  await x.register();
  await x.delivery.drain('thread-1');
  assert.equal(x.called, 1);
  assert.equal(x.receiptSawGrant, true, 'granted to the subscriber for the action');
  assert.equal(x.otherSawGrant, false, 'never granted to another instance');
  assert.equal(await x.entitlements.isEntitled('subscriber', HMR), false, 'revoked when the action returns');
});

test('failure revokes grant before surfacing error and cursor stays retryable', async () => {
  const x = fixture({ fails: true });
  await x.register();
  await assert.rejects(x.delivery.drain('thread-1'), /action failed/);
  assert.equal(x.receiptSawGrant, true);
  assert.equal(await x.entitlements.isEntitled('subscriber', HMR), false);
  assert.equal((await x.port.load()).audit.at(-1).revokeReason, 'action_failed');
});

test('self echo never gains media entitlement', async () => {
  const x = fixture({ selfEcho: true });
  await x.register();
  await x.delivery.drain('thread-1');
  assert.equal(x.called, 1);
  assert.equal(x.receiptSawGrant, false);
  assert.equal((await x.port.load()).audit.length, 0);
});

test('failed durable grant prevents action invocation', async () => {
  const x = fixture({ failGrant: true });
  await x.register();
  await assert.rejects(x.delivery.drain('thread-1'));
  assert.equal(x.called, 0);
  assert.deepEqual(x.errors, [{ subscriberId: 'subscriber', threadId: 'thread-1', errorKind: 'Error' }]);
});

test('Host timeout revokes before surfacing failure', async () => {
  const x = fixture({ hangs: true, actionTimeoutMs: 10 });
  await x.register();
  await assert.rejects(x.delivery.drain('thread-1'), (error) => error?.status === 504 && error?.code === 'TIMEOUT');
  assert.equal(await x.entitlements.isEntitled('subscriber', HMR), false);
  assert.equal((await x.port.load()).audit.at(-1).revokeReason, 'action_timeout');
});

test('instance stop cancels in-flight action and revokes before returning', async () => {
  const x = fixture({ hangs: true, actionTimeoutMs: 1000 });
  await x.register();
  const draining = x.delivery.drain('thread-1');
  for (let attempt = 0; attempt < 10 && !(await x.entitlements.isEntitled('subscriber', HMR)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await x.delivery.cancelInstance('subscriber');
  await assert.rejects(draining, /cancelled/);
  assert.equal(await x.entitlements.isEntitled('subscriber', HMR), false);
  assert.equal((await x.port.load()).audit.at(-1).revokeReason, 'instance_stopped');
});
