import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  FilePluginPackageQuarantineStore,
  PluginManagerService,
  PluginPackageQuarantineManagerAdapter,
  PluginPackageQuarantineStoreError,
} from '../dist/domains/plugin/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-quarantine-'));
  roots.push(root);
  const path = join(root, 'quarantines.json');
  const store = new FilePluginPackageQuarantineStore(path, { now: () => 12_000 });
  return { path, store };
}

const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const replacementDigest = `sha512-${Buffer.alloc(64, 8).toString('base64')}`;

describe('F202 package quarantine ledger', () => {
  it('persists only bounded source identity and a typed failure, never a local host path', async () => {
    const { path, store } = await fixture();

    const record = await store.record({
      packageDigest: digest,
      source: { kind: 'local-archive', path: '/private/operator/plugin.tgz' },
      failureCode: 'INVALID_PACKAGE_ARCHIVE',
    });

    assert.match(record.pluginId, /^rejected-[a-f0-9]{24}$/);
    assert.equal(record.revision, 1);
    assert.equal(record.failure.message, 'Plugin package archive failed Host verification.');
    const persisted = await readFile(path, 'utf8');
    assert.equal(persisted.includes('/private/'), false);
    assert.deepEqual((await new FilePluginPackageQuarantineStore(path).list())[0], record);
  });

  it('projects a quarantined catalog artifact as removable but never executable', async () => {
    const { store } = await fixture();
    await store.record({
      pluginId: 'official.video',
      displayName: 'Video Analysis',
      availableVersion: '1.0.0',
      packageDigest: digest,
      source: {
        kind: 'catalog',
        catalogId: 'video',
        packageName: '@clowder-ai/video',
      },
      failureCode: 'PACKAGE_DIGEST_MISMATCH',
    });
    const quarantine = new PluginPackageQuarantineManagerAdapter(store);
    const manager = new PluginManagerService({
      catalog: { snapshot: async () => ({ candidates: [], status: 'fresh', refreshedAt: 12_000 }) },
      inventory: { snapshot: async () => ({ schemaVersion: 1, packages: [], instances: [], grants: [] }) },
      quarantine,
    });

    const [plugin] = (await manager.list()).plugins;

    assert.equal(plugin.pluginId, 'official.video');
    assert.equal(plugin.artifact, 'quarantined');
    assert.equal(plugin.actions.install, false);
    assert.equal(plugin.actions.setEnabled, false);
    assert.equal(plugin.actions.uninstall, true);
    assert.equal(plugin.lifecycleRevision, 1);
    assert.equal(plugin.diagnostic.code, 'PACKAGE_DIGEST_MISMATCH');

    const removed = await manager.uninstall(plugin.pluginId, { expectedRevision: 1 });
    assert.deepEqual(removed, { pluginId: plugin.pluginId, pluginInstanceId: null });
    assert.deepEqual(await store.list(), []);
  });

  it('does not let an obsolete quarantine hide a replacement catalog package', async () => {
    const { store } = await fixture();
    await store.record({
      pluginId: 'official.video',
      displayName: 'Video Analysis',
      availableVersion: '1.0.0',
      packageDigest: digest,
      source: {
        kind: 'catalog',
        catalogId: 'video',
        packageName: '@clowder-ai/video',
      },
      failureCode: 'PACKAGE_DIGEST_MISMATCH',
    });
    const manager = new PluginManagerService({
      catalog: {
        snapshot: async () => ({
          candidates: [
            {
              catalogId: 'video',
              pluginId: 'official.video',
              packageName: '@clowder-ai/video',
              version: '1.0.1',
              packageDigest: replacementDigest,
              displayName: 'Video Analysis',
              ownerAuthRequired: false,
              capabilities: [],
            },
          ],
          status: 'fresh',
          refreshedAt: 13_000,
        }),
      },
      inventory: { snapshot: async () => ({ schemaVersion: 1, packages: [], instances: [], grants: [] }) },
      quarantine: new PluginPackageQuarantineManagerAdapter(store),
    });

    const [plugin] = (await manager.list()).plugins;

    assert.equal(plugin.artifact, 'absent');
    assert.equal(plugin.availableVersion, '1.0.1');
    assert.equal(plugin.packageDigest, replacementDigest);
    assert.equal(plugin.actions.install, true);
  });

  it('fences stale quarantine removal without losing the rejection record', async () => {
    const { store } = await fixture();
    const record = await store.record({
      packageDigest: digest,
      source: { kind: 'local-directory' },
      failureCode: 'INVALID_PACKAGE_ARCHIVE',
    });

    await assert.rejects(
      () => store.remove(record.pluginId, 99),
      (error) => error instanceof PluginPackageQuarantineStoreError && error.code === 'STALE_REVISION',
    );
    assert.equal((await store.list()).length, 1);
  });
});
