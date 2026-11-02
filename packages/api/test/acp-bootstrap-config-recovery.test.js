import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ExternalPluginLifecycleService } from '../dist/domains/plugin/external-plugin-lifecycle.js';
import { FilePluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';
import { profile, rootRecoveryFixture } from './helpers/acp-root-recovery-fixture.js';

const keys = [
  'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
  'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
  'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
];
let original;
beforeEach(() => {
  original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
  process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'warn-bootstrap-root';
});
afterEach(() => {
  for (const key of keys)
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
});
const windows = { skip: process.platform !== 'win32' };

test('root-only recovery validates on the server, preserves the old reference and bypass argv', windows, async () => {
  const checked = [];
  const f = await rootRecoveryFixture({
    inspect: (root) => {
      checked.push(root);
      return { ok: true, root, trustMode: 'trusted-host' };
    },
  });
  await f.save();
  assert.deepEqual(JSON.parse(f.read().clients), [{ ...profile, bootstrapRoot: 'D:/NewACP' }]);
  assert.equal(f.read().other, 'preserve');
  assert.ok(checked.includes('D:/NewACP'));
});

for (const [label, transform] of [
  ['command', (p) => [{ ...p, command: 'another-client' }]],
  ['args', (p) => [{ ...p, startupArgs: ['--acp'] }]],
  ['name', (p) => [{ ...p, name: 'Renamed' }]],
  ['id', (p) => [{ ...p, id: 'new-id' }]],
  ['MCP', (p) => [{ ...p, mcpWhitelist: [] }]],
  ['new profile', (p) => [p, { ...p, id: 'new' }]],
  ['deletion', () => []],
  ['duplicate ID', (p) => [p, p]],
  ['unknown field', (p) => [{ ...p, env: {} }]],
  ['clear root', (p) => [{ ...p, bootstrapRoot: undefined }]],
  ['relative root', (p) => [{ ...p, bootstrapRoot: './root' }]],
  ['no change', () => [profile]],
  ['equivalent Windows spelling', () => [{ ...profile, bootstrapRoot: 'd:\\OLDACP\\' }]],
])
  test(`audit exception refuses ${label} changes without writing`, windows, async () => {
    const f = await rootRecoveryFixture();
    const before = f.read();
    await assert.rejects(f.save(f.request(transform({ ...profile, bootstrapRoot: 'D:/NewACP' }))));
    assert.deepEqual(f.read(), before);
  });

test('malformed stored data, mixed keys, failed root checks cannot use recovery', windows, async () => {
  for (const options of [{ inspect: () => ({ ok: false, error: 'PRIVATE_DACL' }) }]) {
    const f = await rootRecoveryFixture(options);
    await assert.rejects(f.save());
    assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
  }
  const f = await rootRecoveryFixture();
  await assert.rejects(
    f.save({ ...f.request(), updates: [...f.request().updates, { key: 'other', value: 'modified' }] }),
  );
  writePluginConfig(f.projectRoot, 'test.acp-library', [{ name: 'clients', value: '[invalid' }]);
  await assert.rejects(f.save());
});

test('explicit required wins over the legacy preset; a non-Windows Host never waives audit', async () => {
  const f = await rootRecoveryFixture();
  process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'required';
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  await assert.rejects(f.save());
  if (process.platform !== 'win32') {
    process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'warn-bootstrap-root';
    await assert.rejects(f.save());
  }
});

test('two different path spellings for the same native directory cannot use recovery', windows, async () => {
  const f = await rootRecoveryFixture({ identity: () => 'same-native-directory' });
  await assert.rejects(f.save(), /audit|directory/i);
  assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
});

test('a raw config rewrite with unchanged parsed values invalidates previous admission', windows, async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = await rootRecoveryFixture({
    lifecycleFactory: (_inventory, instance) => ({
      async runWithRuntimeSuspended(input) {
        await input.preflight();
        const path = join(f.projectRoot, '.cat-cafe', 'plugin-config', 'test.acp-library.json');
        writeFileSync(path, readFileSync(path, 'utf8') + '\n');
        return input.operation(instance);
      },
    }),
  });
  await assert.rejects(f.save(), /audit|changed/i);
  assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
});

test('preflight admission cannot survive concurrent config or installation changes', windows, async () => {
  for (const mutation of ['config', 'installation']) {
    const f = await rootRecoveryFixture({
      lifecycleFactory: (inventory, instance) => ({
        async runWithRuntimeSuspended(input) {
          await input.preflight();
          if (mutation === 'config')
            writePluginConfig(f.projectRoot, 'test.acp-library', [{ name: 'other', value: 'concurrent' }]);
          else
            await inventory.transaction((tx) => {
              const current = tx.instances.get(instance.pluginInstanceId);
              tx.instances.put({ ...current, lifecycleRevision: current.lifecycleRevision + 1 });
            });
          return input.operation(instance);
        },
      }),
    });
    await assert.rejects(f.save());
    assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
  }
});

test(
  'real lifecycle suspension advances revisions without invalidating authorized root recovery',
  windows,
  async () => {
    const f = await rootRecoveryFixture({
      lifecycleFactory: (store) =>
        new ExternalPluginLifecycleService({ store, supervisor: { start: async () => {}, stop: async () => {} } }),
    });
    await f.inventory.transaction((tx) => tx.instances.put({ ...f.instance, runtimeState: 'crashed' }));
    await f.save();
    const saved = (await f.inventory.snapshot()).instances[0];
    assert.equal(saved.lifecycleRevision, f.instance.lifecycleRevision + 2);
    assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, 'D:/NewACP');
  },
);

test('runtime refresh failure reports configuration saved, and preserves the value for recovery', windows, async () => {
  const f = await rootRecoveryFixture({
    lifecycleFactory: (store) =>
      new ExternalPluginLifecycleService({
        store,
        supervisor: {
          start: async () => {},
          stop: async () => {},
          configRefresh: async () => {
            throw new Error('refresh failed');
          },
        },
      }),
  });
  await f.inventory.transaction((tx) =>
    tx.instances.put({ ...f.instance, configReadiness: 'ready', activationState: 'enabled', runtimeState: 'healthy' }),
  );
  await assert.rejects(f.save(), /Configuration saved, but/);
  assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, 'D:/NewACP');
});

test('bad package integrity and stale lifecycle revision cannot reach persistence', windows, async () => {
  for (const kind of ['integrity', 'revision']) {
    const f = await rootRecoveryFixture();
    if (kind === 'integrity') {
      const resolve = f.packages.resolveInstalledPackage.bind(f.packages);
      f.packages.resolveInstalledPackage = async (digest) => ({
        ...(await resolve(digest)),
        verifyIntegrity: async () => {
          throw new Error('integrity mismatch');
        },
      });
    } else
      await f.inventory.transaction((tx) =>
        tx.instances.put({ ...f.instance, lifecycleRevision: f.instance.lifecycleRevision + 1 }),
      );
    await assert.rejects(f.save());
    assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
  }
});

for (const resumeFailure of [false, true])
  test(
    `inventory failure compensates config; resumeFailure=${resumeFailure}; same C request can retry`,
    windows,
    async () => {
      const { join, win32 } = await import('node:path');
      const { rename } = await import('node:fs/promises');
      const f = await rootRecoveryFixture();
      const path = join(f.projectRoot, 'inventory.json');
      const snapshot = await f.inventory.snapshot();
      const initial = new FilePluginInventoryStore(path);
      await initial.transaction((tx) => {
        for (const pkg of snapshot.packages) tx.packages.put(pkg);
        for (const instance of snapshot.instances) tx.instances.put(instance);
        if (resumeFailure)
          tx.instances.put({
            ...f.instance,
            activationState: 'enabled',
            runtimeState: 'crashed',
            configReadiness: 'ready',
          });
      });
      let broken = true;
      const inventory = new FilePluginInventoryStore(path, {
        fileOps: {
          rename: async (...args) => {
            if (broken && JSON.parse(f.read().clients)[0].bootstrapRoot === 'D:/NewACP')
              throw new Error('simulated inventory EPERM');
            return rename(...args);
          },
        },
      });
      const service = new HostPluginConfigurationService({
        projectRoot: f.projectRoot,
        inventory,
        packages: f.packages,
        inspectBootstrapRoot: (root) => ({ ok: true, root, trustMode: 'trusted-host' }),
        bootstrapDirectoryIdentity: (root) => win32.resolve(root).toLowerCase(),
        ...(resumeFailure
          ? {
              lifecycle: new ExternalPluginLifecycleService({
                store: inventory,
                supervisor: {
                  stop: async () => {},
                  start: async () => {
                    if (broken) throw new Error('runtime startup failure');
                  },
                },
              }),
            }
          : {}),
      });
      await assert.rejects(
        service.configureBootstrapRoot('test.acp-library', f.instance.pluginInstanceId, f.request()),
        resumeFailure
          ? /Previous configuration restored, but the plugin runtime could not be restored/
          : /previous text restored/,
      );
      assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, profile.bootstrapRoot);
      const afterFailure = (await inventory.snapshot()).instances[0];
      if (resumeFailure) assert.equal(afterFailure.runtimeState, 'stopped');
      else assert.equal(afterFailure.lifecycleRevision, f.instance.lifecycleRevision);
      broken = false;
      await service.configureBootstrapRoot('test.acp-library', f.instance.pluginInstanceId, {
        ...f.request(),
        expectedRevision: afterFailure.lifecycleRevision,
      });
      assert.equal((await inventory.snapshot()).instances[0].lifecycleRevision, afterFailure.lifecycleRevision + 1);
    },
  );
