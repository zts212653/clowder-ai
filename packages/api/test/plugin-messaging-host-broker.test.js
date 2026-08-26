import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalCandidate,
  externalManifest,
} from './plugin-external-runtime-helpers.js';

const GRANTS = ['messaging.send', 'messaging.appendElements', 'message.event.subscribe'];

test('six plugin-to-Host messaging rows dispatch through K-1 without a second Broker call ledger', async () => {
  const [{ MessageStore }, { createMessagingDomain }, { createMessagingBrokerHandlers }] = await Promise.all([
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/messaging/messaging-service.js'),
    import('../dist/domains/plugin/host-broker/messaging-handler.js'),
  ]);
  const messaging = createMessagingDomain({ messageStore: new MessageStore() });
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-m0-host-broker-'));
  const manifest = externalManifest();
  manifest.features[0].capabilities = GRANTS;
  const harness = await createExternalRuntimeHarness({
    rootDir,
    manifest,
    effectiveGrants: GRANTS,
    methods: createMessagingBrokerHandlers({ messaging }),
  });
  const connection = await harness.broker.openExternalConnection(EXTERNAL_INSTANCE_ID);
  const binding = await connection.hello(externalCandidate());
  await connection.ready({ bindingNonce: binding.bindingNonce });

  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: EXTERNAL_INSTANCE_ID,
    threadId: 'thread-1',
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: true },
  });
  const subscribed = await connection.call('messaging.subscribe', { handle: handleId });
  const sent = await connection.call('messaging.send', {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: 'broker-send-1',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'broker route' } }],
    },
  });
  assert.equal(sent.messageHandle.kind, 'message');

  const firstRead = await connection.call('messaging.read', {
    subscriptionId: subscribed.subscriptionId,
    limit: 32,
  });
  assert.equal(firstRead.events.length, 1);
  assert.equal(
    await connection.call('messaging.ack', {
      subscriptionId: subscribed.subscriptionId,
      ackToken: firstRead.ackToken,
    }),
    null,
  );

  const appended = await connection.call('messaging.appendElements', {
    handle: sent.messageHandle,
    operationId: 'broker-append-1',
    baseRevision: 1,
    elements: [
      {
        elementId: 'el-2',
        kind: 'text',
        payload: { text: 'appended' },
        derivedFromElementId: 'el-1',
      },
    ],
  });
  assert.equal(appended.revision, 2);

  const snapshot = await connection.call('messaging.snapshot', {
    subscriptionId: subscribed.subscriptionId,
    maxItems: 8,
  });
  assert.equal(snapshot.items[0].revision, 2);
  assert.equal(snapshot.nextPageToken, null);
  assert.equal(typeof snapshot.snapshotAckToken, 'string');
  assert.equal((await harness.brokerStore.snapshot()).calls.length, 0, 'K-1 remains the sole messaging ledger');

  await assert.rejects(
    connection.call('messaging.read', { subscriptionId: subscribed.subscriptionId, limit: 0 }),
    (error) => error?.code === 'INVALID_CALL_INPUT',
  );
});
