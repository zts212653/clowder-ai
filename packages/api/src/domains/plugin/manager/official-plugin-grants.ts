import type { Capability } from '@clowder-ai/plugin-contract';
import type { HostInventoryControlPlane } from '../host-inventory/control-plane.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { MachineCatalogHostPolicy } from './machine-catalog-provider.js';

export interface OfficialPluginGrantChange {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
}

/**
 * F202 W2-6 — brings every installed plugin that has a Host-owned policy to what that policy allows
 * today (within what its package requests), so a policy fix reaches instances installed before it,
 * not only new installs. Run at startup, before any runtime resumes, so each one starts with the
 * grants it will run with. Plugins without a policy are left alone.
 */
export async function reconcileOfficialPluginGrants(input: {
  readonly store: Pick<PluginInventoryStore, 'snapshot'>;
  readonly inventory: Pick<HostInventoryControlPlane, 'reconcileGrants'>;
  readonly hostPolicies: readonly MachineCatalogHostPolicy[];
}): Promise<readonly OfficialPluginGrantChange[]> {
  const snapshot = await input.store.snapshot();
  const changes: OfficialPluginGrantChange[] = [];
  for (const instance of snapshot.instances) {
    if (instance.lifecycleState !== 'installed') continue;
    const policy = input.hostPolicies.find((candidate) => candidate.pluginId === instance.pluginId);
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === instance.pluginInstanceId);
    if (!policy || !grants) continue;
    const allowed = new Set<Capability>(policy.effectiveGrants);
    const target = grants.requestedCapabilities.filter((capability) => allowed.has(capability));
    const added = target.filter((capability) => !grants.effectiveGrants.includes(capability));
    const removed = grants.effectiveGrants.filter((capability) => !target.includes(capability));
    if (added.length === 0 && removed.length === 0) continue;
    await input.inventory.reconcileGrants({
      pluginInstanceId: instance.pluginInstanceId,
      allowedCapabilities: policy.effectiveGrants,
      expectedGrantRevision: grants.grantRevision,
    });
    changes.push({ pluginId: instance.pluginId, pluginInstanceId: instance.pluginInstanceId, added, removed });
  }
  return changes;
}
