import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { DEFAULT_PLUGIN_CONTRACT_RUNTIME } from '../dist/domains/plugin/host-inventory/contract-policy.js';
import { FilePluginInventoryStore, MemoryPluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';

const clone = globalThis.structuredClone;
let directory;
let file;

function inventory(count = 1) {
  return {
    schemaVersion: 1,
    packages: Array.from({ length: count }, (_, index) => {
      const manifest = {
        pluginId: `dev.clowder.fixture${index}`,
        version: '1.0.0',
        contractVersion: '0.1.0',
        name: `Synthetic ${index}`,
        features: [{ id: 'messaging', name: 'Messaging', resources: [] }],
        runtime: { transport: 'builtin' },
      };
      return {
        packageDigest: `sha512-${createHash('sha512').update(`fixture-${index}`).digest('base64')}`,
        pluginId: manifest.pluginId,
        version: manifest.version,
        contractVersion: manifest.contractVersion,
        manifest,
        signalSchemas: {},
        packageState: 'installed',
        verifiedAt: 1000,
        updatedAt: 1000,
      };
    }),
    instances: [],
  };
}

function countInventoryCopies() {
  let copies = 0;
  mock.method(globalThis, 'structuredClone', (value, options) => {
    if (value?.schemaVersion === 1 && Array.isArray(value.packages) && Array.isArray(value.instances)) copies++;
    return clone(value, options);
  });
  return () => copies;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'task229-inventory-copy-'));
  file = join(directory, 'inventory.json');
  await writeFile(file, JSON.stringify(inventory()), { mode: 0o600 });
});

afterEach(async () => {
  mock.restoreAll();
  await rm(directory, { recursive: true });
});

test('a fresh file snapshot has no redundant whole-inventory deep copy', async () => {
  await writeFile(file, JSON.stringify(inventory(32)));
  const copies = countInventoryCopies();
  let reads = 0;
  const store = new FilePluginInventoryStore(file, {
    fileOps: {
      readFile: async (...args) => {
        reads++;
        return readFile(...args);
      },
    },
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages.length, 32);
  assert.equal(reads, 1, 'Read the current file before returning');
  assert.equal(copies(), 0, 'Do not deep-copy an already freshly parsed file snapshot');
});

test('file results are independent and observe external changes and newly corrupt bytes', async () => {
  const store = new FilePluginInventoryStore(file);
  const first = await store.snapshot();
  first.packages[0].manifest.features[0].resources.push('synthetic-mutation');
  first.packages[0].manifest.name = 'caller mutation';
  const second = await store.snapshot();
  assert.deepEqual(second.packages[0].manifest.features[0].resources, []);
  assert.equal(second.packages[0].manifest.name, 'Synthetic 0');
  assert.notEqual(first.packages[0].manifest, second.packages[0].manifest);
  const changed = inventory();
  changed.packages[0].manifest.name = 'current disk';
  await writeFile(file, JSON.stringify(changed));
  assert.equal((await store.snapshot()).packages[0].manifest.name, 'current disk');
  await writeFile(file, '{invalid-json');
  await assert.rejects(() => store.snapshot(), { code: 'CORRUPT_SNAPSHOT' });
});

test('identical file bytes still re-evaluate the current contract on every read', async () => {
  let allowed = true;
  let validations = 0;
  const contract = {
    ...DEFAULT_PLUGIN_CONTRACT_RUNTIME,
    validateManifest: (value) => {
      validations++;
      return allowed ? DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(value) : { valid: false, errors: [] };
    },
  };
  const store = new FilePluginInventoryStore(file, { contract });
  assert.ok((await store.snapshot()).packages[0].manifest);
  allowed = false;
  const incompatible = (await store.snapshot()).packages[0];
  assert.equal(incompatible.manifest, null);
  assert.equal(incompatible.incompatibleManifest.pluginId, 'dev.clowder.fixture0');
  allowed = true;
  assert.ok((await store.snapshot()).packages[0].manifest);
  assert.equal(validations, 3, 'No parsed/authority cache may replace fresh contract validation');
});

test('memory snapshots keep their deep-copy isolation', async () => {
  const store = new MemoryPluginInventoryStore(inventory());
  const copies = countInventoryCopies();
  const first = await store.snapshot();
  first.packages[0].manifest.features[0].resources.push('synthetic-mutation');
  first.packages[0].manifest.name = 'caller mutation';
  const second = await store.snapshot();
  assert.equal(second.packages[0].manifest.name, 'Synthetic 0');
  assert.deepEqual(second.packages[0].manifest.features[0].resources, []);
  assert.equal(copies(), 2);
});
