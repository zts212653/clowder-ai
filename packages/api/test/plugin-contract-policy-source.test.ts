import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DEFAULT_PLUGIN_CONTRACT_RUNTIME,
  isManifestContractSupported,
  PLUGIN_CONTRACT_PACKAGE_VERSION,
  PLUGIN_MANIFEST_CONTRACT_RANGE,
} from '../src/domains/plugin/host-inventory/contract-policy.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';

const currentContract = '0.4.0-candidate.0';

test('source policy matches the exact locked contract and rejects the next candidate', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  assert.equal(
    packageJson.dependencies['@clowder-ai/plugin-contract'],
    'file:vendor/clowder-ai-plugin-contract-0.4.0-candidate.0-console-fc05bcbbcf45.tgz',
  );
  const archive = await readFile(
    new URL('../vendor/clowder-ai-plugin-contract-0.4.0-candidate.0-console-fc05bcbbcf45.tgz', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(archive).digest('hex'),
    '0f20fb26a46ad75ea962af10a23217b6c9f699f11f7c1c07bd2113b053478b04',
  );
  assert.equal(PLUGIN_CONTRACT_PACKAGE_VERSION, currentContract);
  assert.equal(isManifestContractSupported(currentContract, PLUGIN_MANIFEST_CONTRACT_RANGE), true);
  assert.equal(isManifestContractSupported('0.4.0-candidate.1', PLUGIN_MANIFEST_CONTRACT_RANGE), false);
});

test('snapshot recovery applies the same current contract policy', async () => {
  const manifest = {
    pluginId: 'dev.clowder.candidate1',
    version: '1.0.0',
    contractVersion: currentContract,
    name: 'Candidate 1 fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [] }],
    runtime: { transport: 'builtin' as const },
  };
  const store = new MemoryPluginInventoryStore(
    {
      schemaVersion: 1,
      packages: [
        {
          packageDigest: `sha512-${createHash('sha512').update('candidate-1').digest('base64')}`,
          pluginId: manifest.pluginId,
          version: manifest.version,
          contractVersion: manifest.contractVersion,
          manifest,
          signalSchemas: {},
          packageState: 'installed',
          verifiedAt: 1_000,
          updatedAt: 1_000,
        },
      ],
      instances: [],
    },
    { contract: DEFAULT_PLUGIN_CONTRACT_RUNTIME },
  );

  const recovered = await store.snapshot();
  assert.equal(recovered.packages[0]?.manifest?.contractVersion, currentContract);
  assert.equal(recovered.packages[0]?.incompatibleManifest, undefined);
});
