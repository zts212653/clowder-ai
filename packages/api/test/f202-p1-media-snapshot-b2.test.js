import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { MediaEntitlementLedger, MemoryMediaEntitlementPort } from '../dist/domains/messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { MediaReferenceAuthority } from '../dist/domains/messaging/media-reference-authority.js';
import { createMessagingDomain } from '../dist/domains/messaging/messaging-service.js';
import { PluginMediaReadService } from '../dist/domains/plugin/host-surface/plugin-media-host.js';

async function fixture() {
  let now = 1000;
  const root = await mkdtemp(join(tmpdir(), 'f202-snapshot-lease-'));
  const ledger = new FileMessagingMediaLedger(join(root, 'media'));
  const entitlements = new MediaEntitlementLedger(new MemoryMediaEntitlementPort(), { now: () => now });
  const messaging = createMessagingDomain({
    messageStore: new MessageStore(),
    mediaReferences: new MediaReferenceAuthority({ ledger, entitlements }),
    mediaEntitlements: entitlements,
    snapshotClock: { now: () => now },
    snapshotAckTokenTtlMs: 120,
  });
  const producer = { pluginInstanceId: 'producer' };
  const subscriber = { pluginInstanceId: 'subscriber' };
  const { handleId: producerHandle } = await messaging.issueThreadHandle({
    pluginInstanceId: 'producer',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: false },
  });
  const { handleId: subscriberHandle } = await messaging.issueThreadHandle({
    pluginInstanceId: 'subscriber',
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: false, canSubscribe: true },
  });
  const { subscriptionId } = await messaging.subscribe(subscriber, subscriberHandle);
  const reference = await ledger.register(Buffer.from('private bytes'), { ownerInstanceId: 'producer' });
  await messaging.send(producer, {
    address: { kind: 'thread_handle', handle: producerHandle },
    idempotencyKey: 'media-1',
    payload: {
      provenance: { epistemicStatus: 'user_intent' },
      elements: [{ elementId: 'media-1', kind: 'media_ref', payload: { type: 'file', reference } }],
    },
  });
  const media = new PluginMediaReadService({ ledger, entitlements });
  const read = () =>
    media.read({ pluginInstanceId: 'subscriber', effectiveGrants: ['media.read'] }, { reference, offset: 0, limit: 1 });
  return {
    messaging,
    entitlements,
    subscriber,
    subscriberHandle,
    subscriptionId,
    reference,
    read,
    advance: (ms) => {
      now += ms;
    },
  };
}

test('concurrent replay cannot leave an obsolete page lease authorized', async () => {
  const x = await fixture();
  const originalGrantMany = x.entitlements.grantMany.bind(x.entitlements);
  let releaseFirst;
  let firstGrantStarted;
  const firstStarted = new Promise((resolve) => {
    firstGrantStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  x.entitlements.grantMany = async (grants) => {
    if (++calls === 1) {
      firstGrantStarted();
      await firstGate;
    }
    return originalGrantMany(grants);
  };

  const first = x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  await firstStarted;
  const replay = await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  releaseFirst();
  await assert.rejects(first, (e) => e?.code === 'STALE_CURSOR');
  assert.ok((await x.read()).dataBase64);
  await x.messaging.ack(x.subscriber, x.subscriptionId, replay.snapshotAckToken);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
});

test('snapshot replay rotates lease and stale token cannot ack or read; new token can ack', async () => {
  const x = await fixture();
  const first = await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  assert.equal(first.items.length, 1);
  assert.equal((await x.read()).dataBase64, Buffer.from('p').toString('base64'));
  const replay = await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  assert.notEqual(replay.snapshotAckToken, first.snapshotAckToken);
  await assert.rejects(
    x.messaging.ack(x.subscriber, x.subscriptionId, first.snapshotAckToken),
    (e) => e?.code === 'STALE_CURSOR',
  );
  await x.messaging.ack(x.subscriber, x.subscriptionId, replay.snapshotAckToken);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
});

test('expired snapshot lease denies read and ack, reread renews until ack', async () => {
  const x = await fixture();
  const first = await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  x.advance(120);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
  await assert.rejects(
    x.messaging.ack(x.subscriber, x.subscriptionId, first.snapshotAckToken),
    (e) => e?.code === 'STALE_CURSOR',
  );
  const replay = await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  assert.notEqual(replay.snapshotAckToken, first.snapshotAckToken);
  assert.ok((await x.read()).dataBase64);
  await x.messaging.ack(x.subscriber, x.subscriptionId, replay.snapshotAckToken);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
});

test('withdraw revokes snapshot media before returning', async () => {
  const x = await fixture();
  await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  await x.messaging.withdrawSubscription(x.subscriber, x.subscriberHandle);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
});

test('explicit handle revocation closes its snapshot lease before returning', async () => {
  const x = await fixture();
  await x.messaging.snapshotPage(x.subscriber, { subscriptionId: x.subscriptionId, maxItems: 10 });
  await x.messaging.revokeHandle(x.subscriberHandle);
  await assert.rejects(x.read(), (e) => e?.code === 'MEDIA_ACCESS_DENIED');
});
