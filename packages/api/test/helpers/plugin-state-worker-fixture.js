import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePluginInventoryStore } from '../../dist/domains/plugin/state-worker/stores.js';

export const digest = `sha512-${createHash('sha512').update('worker-fixture').digest('base64')}`;
export const manifest = {
  pluginId: 'dev.clowder.worker',
  version: '1.0.0',
  contractVersion: '0.1.0',
  name: 'Worker fixture',
  features: [{ id: 'messaging', name: 'Messaging', resources: [] }],
  runtime: { transport: 'builtin' },
};
export const candidate = {
  manifest,
  computedPackageDigest: digest,
  expectedPackageDigest: digest,
  packagePluginId: manifest.pluginId,
};
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'task229-state-recovery-'));
  const file = join(directory, 'inventory.json');
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const open = () => {
    const store = new SqlitePluginInventoryStore(file);
    stores.push(store);
    return store;
  };
  return { directory, file, open };
}
