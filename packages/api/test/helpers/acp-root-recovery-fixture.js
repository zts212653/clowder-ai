import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { FilesystemVerifiedPluginPackageLocator } from '../../dist/domains/plugin/external-runtime/filesystem-package-locator.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
} from '../../dist/domains/plugin/index.js';
import { HostPluginConfigurationService } from '../../dist/domains/plugin/manager/plugin-manager-configuration.js';
import { readPluginConfig, writePluginConfig } from '../../dist/domains/plugin/plugin-config-store.js';

export const profile = {
  id: 'existing-codeagent',
  name: '内网 CodeAgent',
  command: 'codeagent',
  startupArgs: ['--acp', '--permission-mode', 'bypassPermission', '--allow-dangerously-skip-permissions'],
  bootstrapRoot: 'D:/OldACP',
  mcpWhitelist: ['cat-cafe'],
};
export async function rootRecoveryFixture({ grant = true, declaration, inspect, identity, lifecycleFactory } = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'acp-root-recovery-'));
  const source = join(projectRoot, 'source');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(source);
  const manifest = {
    pluginId: 'test.acp-library',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Test ACP',
    features: [{ id: 'clients', name: 'Clients', resources: [], capabilities: ['plugin.config.read'] }],
    configuration: [
      { key: 'clients', kind: 'string', label: 'Clients', required: false, default: '[]' },
      { key: 'other', kind: 'string', label: 'Other', required: false },
    ],
  };
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'agent-provider.json'), JSON.stringify(declaration ?? { configurationKey: 'clients' }));
  const inventory = new MemoryPluginInventoryStore();
  const packagesRoot = join(projectRoot, 'packages');
  const installer = new LocalPluginPackageAdmission({
    inventory: new HostInventoryControlPlane(inventory),
    packagesRoot,
    grantPolicy: async () => (grant ? ['plugin.config.read'] : []),
  });
  const result = await installer.install({ kind: 'local-directory', path: source });
  const instance = (await inventory.snapshot()).instances[0];
  const packages = new FilesystemVerifiedPluginPackageLocator(packagesRoot);
  writePluginConfig(projectRoot, manifest.pluginId, [
    { name: 'clients', value: JSON.stringify([profile]) },
    { name: 'other', value: 'preserve' },
  ]);
  const service = new HostPluginConfigurationService({
    projectRoot,
    inventory,
    packages,
    inspectBootstrapRoot: inspect ?? ((root) => ({ ok: true, root, trustMode: 'trusted-host' })),
    bootstrapDirectoryIdentity: identity ?? ((root) => win32.resolve(root).toLowerCase()),
    ...(lifecycleFactory ? { lifecycle: lifecycleFactory(inventory, instance) } : {}),
  });
  const request = (profiles = [{ ...profile, bootstrapRoot: 'D:/NewACP' }]) => ({
    expectedRevision: instance.lifecycleRevision,
    updates: [{ key: 'clients', value: JSON.stringify(profiles) }],
  });
  return {
    projectRoot,
    inventory,
    instance,
    packages,
    service,
    request,
    result,
    source,
    read: () => readPluginConfig(projectRoot, manifest.pluginId),
    save: (mutation = request()) =>
      service.configureBootstrapRoot(manifest.pluginId, instance.pluginInstanceId, mutation),
  };
}
