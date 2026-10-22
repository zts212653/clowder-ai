import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ExternalPluginLifecycleService } from '../dist/domains/plugin/external-plugin-lifecycle.js';
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

test(
  'malformed stored data, mixed keys, missing grants and failed root checks cannot use recovery',
  windows,
  async () => {
    for (const options of [{ grant: false }, { inspect: () => ({ ok: false, error: 'PRIVATE_DACL' }) }]) {
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
  },
);

test('explicit required audit overrides the legacy alias, and non-Windows never gets the exception', async () => {
  const f = await rootRecoveryFixture();
  process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'required';
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  await assert.rejects(f.save());
  if (process.platform !== 'win32') {
    process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'warn-bootstrap-root';
    await assert.rejects(f.save());
  }
});

test('legacy exact-1 maps only to root-only recovery; explicit strict still disables it', windows, async () => {
  delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
  delete process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE;
  process.env.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY = '1';
  const f = await rootRecoveryFixture();
  await f.save();
  const strict = await rootRecoveryFixture();
  process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'strict';
  await assert.rejects(strict.save());
});

test('preflight admission cannot survive concurrent config or grant changes', windows, async () => {
  for (const mutation of ['config', 'grant']) {
    const f = await rootRecoveryFixture({
      lifecycleFactory: (inventory, instance) => ({
        async runWithRuntimeSuspended(input) {
          await input.preflight();
          if (mutation === 'config')
            writePluginConfig(f.projectRoot, 'test.acp-library', [{ name: 'other', value: 'concurrent' }]);
          else
            await inventory.transaction((tx) => {
              const grant = tx.grants.get(instance.pluginInstanceId);
              tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
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

test(
  'equivalent native IDs, replaced target identity, and raw-file-only concurrent changes are rejected',
  windows,
  async () => {
    const alias = await rootRecoveryFixture({ identity: () => 'same-volume:file-id' });
    await assert.rejects(alias.save());
    let generation = 'initial';
    const changed = await rootRecoveryFixture({
      identity: (root) => `${root}:${generation}`,
      lifecycleFactory: () => ({
        async runWithRuntimeSuspended(input) {
          await input.preflight();
          generation = 'replaced';
          return input.operation(changed.instance);
        },
      }),
    });
    await assert.rejects(changed.save());
    const raw = await rootRecoveryFixture({
      lifecycleFactory: () => ({
        async runWithRuntimeSuspended(input) {
          await input.preflight();
          const path = join(raw.projectRoot, '.cat-cafe/plugin-config/test.acp-library.json');
          await writeFile(path, JSON.stringify(raw.read()));
          return input.operation(raw.instance);
        },
      }),
    });
    await assert.rejects(raw.save());
    const malformed = await rootRecoveryFixture({ profilesDefault: JSON.stringify([profile]) });
    await writeFile(join(malformed.projectRoot, '.cat-cafe/plugin-config/test.acp-library.json'), '{malformed');
    await assert.rejects(malformed.save());
  },
);
