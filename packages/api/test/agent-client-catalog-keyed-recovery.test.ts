import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { recoverAgentClientMetadata } from '../src/domains/plugin/declared/agent-client-metadata.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import type { PackageAdmissionCandidate } from '../src/domains/plugin/host-inventory/types.js';
import { PluginStateClient } from '../src/domains/plugin/state-worker/client.js';
import type { StateOperation } from '../src/domains/plugin/state-worker/protocol.js';
import { SqlitePluginInventoryStore } from '../src/domains/plugin/state-worker/stores.js';

const digest = `sha512-${createHash('sha512').update('catalog-keyed-recovery').digest('base64')}`;
const candidate: PackageAdmissionCandidate = {
  manifest: {
    pluginId: 'local.catalog-recovery',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Legacy catalog fixture',
    features: [{ id: 'agent', name: 'Agent', resources: [] }],
    runtime: { transport: 'builtin' },
  },
  computedPackageDigest: digest,
  expectedPackageDigest: digest,
  packagePluginId: 'local.catalog-recovery',
};

async function fixture(t: TestContext, retired = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-keyed-recovery-'));
  const file = join(directory, 'inventory.json');
  const seed = new MemoryPluginInventoryStore();
  await new HostInventoryControlPlane(seed).installPackage(candidate);
  const snapshot = await seed.snapshot();
  await writeFile(
    file,
    JSON.stringify({
      ...snapshot,
      instances: [
        ...snapshot.instances,
        ...Array.from({ length: retired }, (_, index) => ({
          ...snapshot.instances[0],
          pluginInstanceId: `pi_retired_catalog_${index}`,
          lifecycleState: 'retired',
          retiredAt: 1000,
        })),
      ],
    }),
  );
  const clients: PluginStateClient[] = [];
  const open = async () => {
    const client = new PluginStateClient();
    clients.push(client);
    const inventory = new SqlitePluginInventoryStore(file, { client });
    await inventory.initialize();
    return { client, inventory };
  };
  t.after(async () => {
    for (const client of clients) await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...(await open()), open };
}

test('catalog recovery commits metadata across restart without transferring retired history', async (t) => {
  const h = await fixture(t, 70);
  const send = h.client.request.bind(h.client);
  let retiredRows = 0;
  h.client.request = async <T>(operation: StateOperation): Promise<T> => {
    const result = await send<T>(operation);
    if (operation.op === 'list' && operation.query.entity === 'instance') {
      const page = result as { records: { lifecycleState: string }[] };
      retiredRows += page.records.filter((row) => row.lifecycleState === 'retired').length;
    }
    return result;
  };
  const failures: string[] = [];
  await recoverAgentClientMetadata({
    inventory: h.inventory,
    packages: { resolveInstalledPackage: async () => assert.fail('legacy builtin must not open an archive') },
    onFailure: (pluginId) => failures.push(pluginId),
  });
  assert.deepEqual(failures, []);
  assert.equal(retiredRows, 0, 'recovery must leave retired rows in the SQLite owner');
  assert.equal((await h.inventory.read.packages.get(digest))?.agentClientMetadata, null);
  await h.client.close();
  const restarted = await h.open();
  assert.equal((await restarted.inventory.read.packages.get(digest))?.agentClientMetadata, null);
  assert.equal((await restarted.inventory.snapshot()).instances.length, 71, 'history must remain recoverable');
});

test('reinstall cannot report success when an asynchronous metadata write fails', async (t) => {
  const h = await fixture(t);
  const before = await h.inventory.snapshot();
  const send = h.client.request.bind(h.client);
  const failure = new Error('simulated package metadata write failure');
  h.client.request = async <T>(operation: StateOperation): Promise<T> => {
    if (operation.op === 'put' && operation.entity === 'package') throw failure;
    return send<T>(operation);
  };
  await assert.rejects(
    new HostInventoryControlPlane(h.inventory).reinstallPackage({
      ...candidate,
      agentClientMetadata: null,
      previousPluginInstanceId: before.instances[0].pluginInstanceId,
    }),
    failure,
  );
  assert.deepEqual(await h.inventory.snapshot(), before);
});
