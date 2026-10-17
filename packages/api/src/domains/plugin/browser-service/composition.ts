import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInventorySnapshot } from '../host-inventory/types.js';
import type { PrepareModuleBrowserServices } from '../host-surface/plugin-browser-service-host.js';
import { resolveRetainedBrowserAssets } from './catalog.js';
import { PluginBrowserServiceProvider } from './provider.js';
import { BrowserServiceTransportError } from './transport-policy.js';

/** Capture owner admission once; every subsequent request checks the same installed revision. */
export function createInventoryBrowserServices(options: {
  readonly inventory: PluginInventoryStore;
  readonly identityDirectory: string;
  readonly parentOrigin: string;
}): PrepareModuleBrowserServices & { shutdown(): Promise<void> } {
  const provider = new PluginBrowserServiceProvider({ ...options, assets: resolveRetainedBrowserAssets });
  const prepare: PrepareModuleBrowserServices = async (input) => {
    const initial = await options.inventory.snapshot();
    const instance = initial.instances.find((i) => i.pluginInstanceId === input.pluginInstanceId);
    const grants = initial.grants.find((g) => g.pluginInstanceId === input.pluginInstanceId);
    const lifecycleRevision = instance?.lifecycleRevision,
      grantRevision = grants?.grantRevision;
    const manifest = JSON.stringify(input.packageRecord.manifest);
    const expectedGrants = JSON.stringify([...input.effectiveGrants].sort());
    const check = async (snapshot: PluginInventorySnapshot) => {
      await input.assertCurrent();
      input.signal.throwIfAborted();
      const current = snapshot.instances.find((i) => i.pluginInstanceId === input.pluginInstanceId);
      const currentGrant = snapshot.grants.find((g) => g.pluginInstanceId === input.pluginInstanceId);
      const pkg = snapshot.packages.find((p) => p.packageDigest === input.packageRecord.packageDigest);
      if (
        !current ||
        !currentGrant ||
        current.lifecycleState !== 'installed' ||
        current.activationState !== 'enabled' ||
        current.configReadiness !== 'ready' ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.packageDigest !== input.packageRecord.packageDigest ||
        pkg?.packageState !== 'installed' ||
        JSON.stringify(pkg.manifest) !== manifest ||
        currentGrant.grantRevision !== grantRevision ||
        JSON.stringify([...currentGrant.effectiveGrants].sort()) !== expectedGrants
      )
        throw new BrowserServiceTransportError('BROWSER_SERVICE_REVOKED');
    };
    await check(initial);
    return provider.prepare({ ...input, assertCurrent: async () => check(await options.inventory.snapshot()) });
  };
  return Object.assign(prepare, { shutdown: () => provider.shutdown() });
}
