import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DOMAIN_ERROR_CODE,
  SNAPSHOT_UNAVAILABLE_CODE,
  SNAPSHOT_UNAVAILABLE_MESSAGE,
} from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
  FakePluginProcessAdapter,
  readFrame,
  sendFrame,
  wireRequest,
} from './plugin-external-runtime-helpers.js';

const DELIVER_INPUT = {
  deliveryId: 'delivery-stdio-1',
  threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
  envelope: {
    messageId: 'message-1',
    revision: 1,
    threadId: 'thread-1',
    actor: { kind: 'plugin', id: 'inst-source' },
    audience: { kind: 'public' },
    occurredAt: '2026-08-21T01:00:00.000Z',
    payload: {
      provenance: { origin: { kind: 'plugin', instanceId: 'inst-source' }, epistemicStatus: 'inference' },
      elements: [{ elementId: 'element-1', kind: 'text', payload: { text: 'hello' } }],
    },
  },
};

function manifestWithCapabilities(...capabilities) {
  const manifest = externalManifest();
  return {
    ...manifest,
    features: manifest.features.map((feature) => ({
      ...feature,
      capabilities: [...feature.capabilities, ...capabilities],
    })),
  };
}

async function runningHarness({ effectiveGrants, manifest, methods = [] }) {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-m0-stdio-messaging-'));
  const harness = await createExternalRuntimeHarness({ rootDir, manifest, methods, effectiveGrants });
  const processes = new FakePluginProcessAdapter();
  const supervisor = new ExternalPluginRuntimeSupervisor({
    inventory: harness.inventory,
    broker: harness.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest,
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
  });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await processes.nextProcess();
  await completeExternalHandshake(child);
  const handle = await starting;
  return { ...harness, child, handle, supervisor };
}

test('Host delivers to the exact active stdio runtime only after onMessage authority succeeds', async () => {
  const manifest = manifestWithCapabilities('onMessage');
  const harness = await runningHarness({ effectiveGrants: ['events.publish', 'onMessage'], manifest });

  const pending = harness.supervisor.deliver(EXTERNAL_INSTANCE_ID, DELIVER_INPUT);
  const request = await readFrame(harness.child);
  assert.equal(request.method, 'host.messaging.deliver');
  assert.deepEqual(request.params.input, DELIVER_INPUT);
  sendFrame(harness.child, {
    jsonrpc: '2.0',
    id: request.id,
    result: { deliveryId: DELIVER_INPUT.deliveryId },
  });
  assert.deepEqual(await pending, { deliveryId: DELIVER_INPUT.deliveryId });
  await harness.supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('stdio maps a K-1 MessagingError to the published DOMAIN_ERROR without closing authority', async () => {
  const [{ MessageStore }, { createMessagingDomain }, { createMessagingBrokerHandlers }] = await Promise.all([
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/messaging/messaging-service.js'),
    import('../dist/domains/plugin/host-broker/messaging-handler.js'),
  ]);
  const messaging = createMessagingDomain({ messageStore: new MessageStore() });
  const manifest = manifestWithCapabilities('messaging.send');
  const harness = await runningHarness({
    effectiveGrants: ['events.publish', 'messaging.send'],
    manifest,
    methods: createMessagingBrokerHandlers({ messaging }),
  });

  sendFrame(
    harness.child,
    wireRequest('send-missing-handle', 'messaging.send', {
      address: { kind: 'thread_handle', handle: 'missing-handle' },
      idempotencyKey: 'missing-handle-1',
      payload: {
        provenance: { epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
      },
    }),
  );
  const response = await readFrame(harness.child);
  assert.equal(response.error.code, DOMAIN_ERROR_CODE);
  assert.deepEqual(response.error.data, { code: 'NOT_FOUND' });
  assert.equal(harness.child.terminateCalls, 0);
  await harness.supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('stdio preserves the published snapshot-unavailable reason without closing authority', async () => {
  const [
    { MessageStore },
    { createMessagingDomain },
    { SnapshotUnavailableHostError },
    { createMessagingBrokerHandlers },
  ] = await Promise.all([
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    import('../dist/domains/messaging/messaging-service.js'),
    import('../dist/domains/messaging/contract/host-types.js'),
    import('../dist/domains/plugin/host-broker/messaging-handler.js'),
  ]);
  const messaging = createMessagingDomain({ messageStore: new MessageStore() });
  messaging.snapshotPage = async () => {
    throw new SnapshotUnavailableHostError('VIEW_EXPIRED');
  };
  const manifest = manifestWithCapabilities('message.event.subscribe');
  const harness = await runningHarness({
    effectiveGrants: ['events.publish', 'message.event.subscribe'],
    manifest,
    methods: createMessagingBrokerHandlers({ messaging }),
  });

  sendFrame(
    harness.child,
    wireRequest('snapshot-expired', 'messaging.snapshot', {
      subscriptionId: 'sub-expired',
      maxItems: 1,
    }),
  );
  const response = await readFrame(harness.child);
  assert.equal(response.error.code, SNAPSHOT_UNAVAILABLE_CODE);
  assert.equal(response.error.message, SNAPSHOT_UNAVAILABLE_MESSAGE);
  assert.deepEqual(response.error.data, { reason: 'VIEW_EXPIRED' });
  assert.equal(harness.child.terminateCalls, 0);
  await harness.supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('Host delivery without onMessage authority fails closed before writing a stdio request', async () => {
  const manifest = externalManifest();
  const harness = await runningHarness({ effectiveGrants: ['events.publish'], manifest });

  await assert.rejects(
    harness.supervisor.deliver(EXTERNAL_INSTANCE_ID, DELIVER_INPUT),
    (error) => error?.code === 'DELIVERY_REJECTED',
  );
  assert.equal(harness.child.stdin.readableLength, 0);
  await harness.handle.closed;
});
