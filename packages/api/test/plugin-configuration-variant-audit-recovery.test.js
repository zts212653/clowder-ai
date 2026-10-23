import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { FilesystemVerifiedPluginPackageLocator } from '../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../dist/domains/plugin/index.js';
import { HostPluginConfigurationService } from '../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { readPluginConfig, readPluginConfigText } from '../dist/domains/plugin/plugin-config-store.js';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'variant-audit-recovery-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const source = join(projectRoot, 'source');
  await mkdir(source);
  const pluginId = 'test.variant-acp';
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.2.0',
    name: 'Variant ACP',
    features: [{ id: 'clients', name: 'Clients', resources: [], capabilities: ['plugin.config.read', 'secret.read'] }],
    configuration: [
      { key: 'clients', kind: 'string', label: 'Clients', required: false, default: '[]' },
      {
        key: 'mode',
        kind: 'select',
        label: 'Mode',
        required: true,
        default: 'local',
        options: [
          { value: 'local', label: 'Local' },
          { value: 'remote', label: 'Remote' },
        ],
      },
      { key: 'token', kind: 'secret', label: 'Token', required: true, requiredWhen: { key: 'mode', value: 'remote' } },
    ],
    configurationVariants: {
      discriminator: 'mode',
      branches: [
        { id: 'local', when: { properties: { mode: { const: 'local' } } }, fields: [] },
        { id: 'remote', when: { properties: { mode: { const: 'remote' } } }, fields: ['token'] },
      ],
    },
  };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'agent-provider.json'), JSON.stringify({ configurationKey: 'clients' }));
  const inventory = new MemoryPluginInventoryStore();
  const packagesRoot = join(projectRoot, 'packages');
  const installer = new LocalPluginPackageAdmission({
    inventory: new HostInventoryControlPlane(inventory),
    packagesRoot,
    grantPolicy: async () => ['plugin.config.read', 'secret.read'],
  });
  await installer.install({ kind: 'local-directory', path: source });
  const instance = (await inventory.snapshot()).instances[0];
  const service = new HostPluginConfigurationService({
    projectRoot,
    inventory,
    packages: new FilesystemVerifiedPluginPackageLocator(packagesRoot),
    inspectBootstrapRoot: (root) => ({ ok: true, root, trustMode: 'trusted-host' }),
    bootstrapDirectoryIdentity: (root) => win32.resolve(root).toLowerCase(),
  });
  return {
    service,
    inventory,
    pluginId,
    projectRoot,
    instance,
    request: async (updates) => ({
      expectedRevision: (await inventory.snapshot()).instances[0].lifecycleRevision,
      updates,
    }),
    read: () => readPluginConfig(projectRoot, pluginId),
  };
}

test('variant readiness and secret bytes survive the transaction helper used by root recovery', async (t) => {
  const f = await fixture(t);
  const configure = async (updates) =>
    f.service.configure(f.pluginId, f.instance.pluginInstanceId, await f.request(updates));
  await configure([{ key: 'mode', value: 'local' }]);
  assert.equal((await f.inventory.snapshot()).instances[0].configReadiness, 'ready');
  const fields = await f.service.fields(f.pluginId);
  assert.ok(fields.every((field) => field.configurationVariants?.discriminator === 'mode'));
  await configure([{ key: 'mode', value: 'remote' }]);
  assert.equal((await f.inventory.snapshot()).instances[0].configReadiness, 'incomplete');
  await configure([{ key: 'token', value: ' \t\n' }]);
  assert.equal((await f.inventory.snapshot()).instances[0].configReadiness, 'incomplete');
  assert.equal(f.read().token, ' \t\n');
  const secret = ' \tfixture-token\n';
  await configure([{ key: 'token', value: secret }]);
  assert.equal((await f.inventory.snapshot()).instances[0].configReadiness, 'ready');
  assert.equal(f.read().token, secret);
});

test(
  'a declared variant selector cannot be mixed into the root-only audit exception',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const keys = ['CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE', 'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE'];
    const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
      for (const key of keys) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });
    process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
    process.env.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE = 'warn-bootstrap-root';
    const f = await fixture(t);
    const profile = {
      id: 'existing',
      name: 'Existing ACP',
      command: 'codeagent',
      startupArgs: ['--acp'],
      bootstrapRoot: 'D:/OldACP',
    };
    await f.service.configure(
      f.pluginId,
      f.instance.pluginInstanceId,
      await f.request([
        { key: 'clients', value: JSON.stringify([profile]) },
        { key: 'mode', value: 'local' },
      ]),
    );
    const rootUpdate = { key: 'clients', value: JSON.stringify([{ ...profile, bootstrapRoot: 'D:/NewACP' }]) };
    const before = readPluginConfigText(f.projectRoot, f.pluginId);
    await assert.rejects(
      f.service.configureBootstrapRoot(
        f.pluginId,
        f.instance.pluginInstanceId,
        await f.request([rootUpdate, { key: 'mode', value: 'remote' }]),
      ),
      { code: 'AUDIT_UNAVAILABLE' },
    );
    assert.equal(readPluginConfigText(f.projectRoot, f.pluginId), before);
    await f.service.configureBootstrapRoot(f.pluginId, f.instance.pluginInstanceId, await f.request([rootUpdate]));
    assert.equal(f.read().mode, 'local');
    assert.equal(JSON.parse(f.read().clients)[0].bootstrapRoot, 'D:/NewACP');
    assert.equal((await f.inventory.snapshot()).instances[0].configReadiness, 'ready');
  },
);
