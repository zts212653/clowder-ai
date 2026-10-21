import { createHash } from 'node:crypto';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';

export const PLUGIN_ID = 'official.example-source';
export const INSTANCE_ID = 'pi_example';
export const PACKAGE_DIGEST = `sha512-${createHash('sha512').update('k2b-example-package').digest('base64')}`;

export function pluginManifest(capabilities = ['messaging.send']) {
  return {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Example Source',
    features: [
      {
        id: 'source',
        name: 'Source',
        resources: [],
        capabilities,
      },
    ],
    signals: {
      provides: [
        {
          type: 'example.signal.v1',
          schemaRef: 'schemas/example.signal.v1.schema.json',
          epistemicStatus: 'observation',
          privacyClass: 'content-adjacent',
          sourceClass: 'remote-service',
        },
      ],
    },
    runtime: { transport: 'builtin' },
  };
}

export function candidateHello(overrides = {}) {
  return {
    pluginId: PLUGIN_ID,
    packageDigest: PACKAGE_DIGEST,
    contractVersion: '0.1.0',
    wireVersion: '0.1.0',
    ...overrides,
  };
}

export function messageSendInput(overrides = {}) {
  return {
    address: { kind: 'thread_handle', handle: 'thread-handle-1' },
    idempotencyKey: 'send-1',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
    },
    ...overrides,
  };
}

export function messageSendReceipt(messageId) {
  return {
    messageId,
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: `handle-${messageId}` },
  };
}

export async function readyInventory({ effectiveGrants = ['messaging.send'] } = {}) {
  const inventory = new MemoryPluginInventoryStore();
  const controlPlane = new HostInventoryControlPlane(inventory, {
    createInstanceId: () => INSTANCE_ID,
    now: () => 1_000,
  });
  await controlPlane.installPackage({
    manifest: pluginManifest(effectiveGrants),
    computedPackageDigest: PACKAGE_DIGEST,
    expectedPackageDigest: PACKAGE_DIGEST,
    packagePluginId: PLUGIN_ID,
    effectiveGrants,
    signalSchemas: {
      'schemas/example.signal.v1.schema.json': {
        type: 'object',
        properties: {
          payload: { type: 'object' },
          source: { type: 'object' },
        },
        required: ['payload', 'source'],
      },
    },
  });
  await inventory.transaction((transaction) => {
    const instance = transaction.instances.get(INSTANCE_ID);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: 1_001,
    });
  });
  return inventory;
}
