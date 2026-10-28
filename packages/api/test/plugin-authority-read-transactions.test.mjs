import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FileHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { FilePluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { readyInventory } from './plugin-host-broker-helpers.js';

for (const kind of ['broker', 'inventory']) {
  test(`${kind}: transactional reads do not commit unchanged authority or depend on JSON write availability`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'authority-read-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, `${kind}.json`);
    const seed =
      kind === 'broker'
        ? { schemaVersion: 1, sessions: [], runtimeLeases: [], calls: [] }
        : await (await readyInventory()).snapshot();
    const original = JSON.stringify(seed);
    await writeFile(path, original);
    let writes = 0;
    const noCommit = async () => {
      writes++;
      throw new Error('unchanged transaction attempted a JSON commit');
    };
    const Store = kind === 'broker' ? FileHostBrokerStore : FilePluginInventoryStore;
    const store = new Store(path, { fileOps: { mkdir: noCommit, writeFile: noCommit, rename: noCommit } });
    const result = await store.transaction((tx) => {
      if (kind === 'broker') {
        const detached = tx.staticFeatures.get();
        detached.epochs.push({ notPersisted: true });
        return tx.sessions.list().length;
      }
      const instance = tx.instances.list()[0];
      instance.runtimeState = 'crashed'; // Reading returns a detached value, not a write port.
      return tx.packages.list().length;
    });
    assert.equal(result, kind === 'broker' ? 0 : seed.packages.length);
    assert.equal(writes, 0);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.deepEqual(await store.snapshot(), seed);
  });
}
