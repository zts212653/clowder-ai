import type { CollectiveArtifactOwnerPort } from '../../collaborative-content/collective-artifact/owner-port.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginGrantRecord, PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { type CollectiveArtifactOwnerHolder, createCollectiveArtifactOwnerProxy } from './collective-artifact-owner.js';
import { createPluginMembersHost, type PluginMembersHost, type PluginMembersServices } from './plugin-members-host.js';

export interface PluginNeutralHost {
  readonly collectiveArtifactOwner?: CollectiveArtifactOwnerPort;
  readonly members: PluginMembersHost;
}
interface Deps {
  readonly collectiveArtifactOwner?: CollectiveArtifactOwnerHolder;
  readonly activationSignal?: AbortSignal;
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly assertActivation: () => void;
  readonly inventory: PluginInventoryStore;
  readonly members?: PluginMembersServices;
}
function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}

/** One activation's neutral ports. The plugin never receives these authority dependencies. */
export async function createPluginNeutralHost(deps: Deps): Promise<PluginNeutralHost> {
  const initial = await deps.inventory.snapshot();
  const instance = initial.instances.find((item) => item.pluginInstanceId === deps.pluginInstanceId);
  const grant = initial.grants.find((item) => item.pluginInstanceId === deps.pluginInstanceId);
  if (!instance || !grant || instance.packageDigest !== deps.packageDigest) refuse('Neutral installation unavailable');
  const pkg = initial.packages.find((item) => item.packageDigest === deps.packageDigest);
  if (!pkg) refuse('Neutral package unavailable');
  // Config saves advance the inventory revision without replacing this activation.
  // assertActivation owns stop/restart invalidation; package and grant fences remain.
  const grantRevision = grant.grantRevision;
  function check(
    current: PluginInstanceRecord | undefined,
    grants: PluginGrantRecord | undefined,
    pkg: PluginPackageRecord | undefined,
    capabilities: readonly string[],
  ): void {
    deps.assertActivation();
    if (
      !current ||
      !grants ||
      current.lifecycleState !== 'installed' ||
      current.activationState !== 'enabled' ||
      current.configReadiness !== 'ready' ||
      current.packageDigest !== deps.packageDigest ||
      grants.grantRevision !== grantRevision ||
      pkg?.packageState !== 'installed' ||
      capabilities.some((capability) => !grants.effectiveGrants.some((g) => g === capability))
    )
      refuse('Neutral installation or capability is no longer current');
  }
  async function current(capabilities: readonly string[]): Promise<void> {
    deps.assertActivation();
    const snapshot = await deps.inventory.snapshot();
    check(
      snapshot.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId),
      snapshot.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId),
      snapshot.packages.find((p) => p.packageDigest === deps.packageDigest),
      capabilities,
    );
  }
  const collective = pkg.pluginId === 'official.collective-connector' && instance.pluginId === pkg.pluginId;
  return Object.freeze({
    members: createPluginMembersHost({ services: deps.members, assertCurrent: current }),
    ...(collective && deps.collectiveArtifactOwner
      ? {
          collectiveArtifactOwner: createCollectiveArtifactOwnerProxy({
            owner: () => deps.collectiveArtifactOwner?.current,
            retainedMedia: () => deps.collectiveArtifactOwner?.retainedMedia,
            pluginInstanceId: deps.pluginInstanceId,
            assertCurrent: () => current([]),
            ...(deps.activationSignal ? { signal: deps.activationSignal } : {}),
          }),
        }
      : {}),
  });
}
