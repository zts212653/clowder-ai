import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { DEFAULT_PLUGIN_CONTRACT_RUNTIME } from '../dist/domains/plugin/host-inventory/contract-policy.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/runtime-composition.js';

function inventory(count) {
  const packages = Array.from({ length: count }, (_, index) => {
    const manifest = {
      pluginId: `dev.clowder.cost${index}`,
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: `Synthetic ${index}`,
      features: [{ id: 'messaging', name: 'Messaging', resources: [] }],
      runtime: { transport: 'builtin' },
    };
    return {
      packageDigest: `sha512-${createHash('sha512').update(`cost-${index}`).digest('base64')}`,
      pluginId: manifest.pluginId,
      version: manifest.version,
      contractVersion: manifest.contractVersion,
      manifest,
      signalSchemas: {},
      packageState: 'installed',
      verifiedAt: 1000,
      updatedAt: 1000,
    };
  });
  return {
    schemaVersion: 1,
    packages,
    instances: packages.map((pkg, index) => ({
      pluginInstanceId: `pi_cost_${index}`,
      pluginId: pkg.pluginId,
      packageDigest: pkg.packageDigest,
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 1,
      installedAt: 1000,
      updatedAt: 1000,
    })),
  };
}

test('real composition authorizes one instance without validating unrelated installed packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'task229-keyed-authority-'));
  const data = join(directory, '.cat-cafe/plugin-host');
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'inventory.json'), JSON.stringify(inventory(12)), { mode: 0o600 });
  const validated = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: directory,
    messageStore: new MessageStore(),
    contract: {
      ...DEFAULT_PLUGIN_CONTRACT_RUNTIME,
      validateManifest(value) {
        validated.push(value.pluginId);
        return DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(value);
      },
    },
  });
  try {
    // Initial import is deliberately outside the steady-state permission query.
    await runtime.inventoryStore.snapshot();
    validated.length = 0;
    const started = performance.now();
    await runtime.broker.authorizeHostDelivery('pi_cost_0');
    await runtime.broker.authorizeHostDelivery('pi_cost_0');
    console.log(
      JSON.stringify({
        observation: 'two-keyed-authority-checks',
        elapsedMs: performance.now() - started,
        packageValidations: validated.length,
      }),
    );
    assert.deepEqual(
      [...new Set(validated)],
      ['dev.clowder.cost0'],
      'A keyed permission query must not validate any unrelated package',
    );
    assert.equal(validated.length, 2, 'An unversioned custom policy is reevaluated for this package on each read');
  } finally {
    await runtime.inventoryStore.close?.();
    await runtime.brokerStore.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
