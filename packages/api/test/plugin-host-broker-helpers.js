import { createHash } from 'node:crypto';
import { HostInventoryControlPlane, MemoryPluginInventoryStore } from '../dist/domains/plugin/index.js';

export const PLUGIN_ID = 'official.example-source';
export const INSTANCE_ID = 'pi_example';
export const PACKAGE_DIGEST = `sha512-${createHash('sha512').update('k2b-example-package').digest('base64')}`;

export function pluginManifest(capabilities = ['events.publish']) {
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

export function eventsPublishInput(overrides = {}) {
  return {
    signalType: 'example.signal.v1',
    eventId: 'event-1',
    idempotencyKey: 'publish-1',
    occurredAt: '2026-08-10T12:00:00Z',
    payload: { artifactId: 'artifact-1' },
    source: { handle: 'example://artifact/1' },
    ...overrides,
  };
}

export async function readyInventory({ effectiveGrants = ['events.publish'] } = {}) {
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
