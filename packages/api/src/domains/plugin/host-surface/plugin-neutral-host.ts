import type { CollectiveMaterialSourcePort } from '@cat-cafe/shared';
import type { CollectiveArtifactOwnerPort } from '../../collaborative-content/collective-artifact/owner-port.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { type CollectiveArtifactOwnerHolder, createCollectiveArtifactOwnerProxy } from './collective-artifact-owner.js';
import {
  type CollectiveMaterialSourceHolder,
  createCollectiveMaterialSourceProxy,
} from './collective-material-source.js';
import { createPluginMembersHost, type PluginMembersHost, type PluginMembersServices } from './plugin-members-host.js';

export interface PluginNeutralHost {
  readonly collectiveMaterialSource?: CollectiveMaterialSourcePort;
  readonly collectiveArtifactOwner?: CollectiveArtifactOwnerPort;
  readonly members: PluginMembersHost;
}
interface Deps {
  readonly collectiveMaterialSource?: CollectiveMaterialSourceHolder;
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

  if (!instance || instance.packageDigest !== deps.packageDigest) refuse('Neutral installation unavailable');
  const pkg = initial.packages.find((item) => item.packageDigest === deps.packageDigest);
  if (!pkg) refuse('Neutral package unavailable');
  // Config saves advance the inventory revision without replacing this activation.
  // assertActivation owns stop/restart invalidation; package and lifecycle fences remain.
  function check(current: PluginInstanceRecord | undefined, pkg: PluginPackageRecord | undefined): void {
    deps.assertActivation();
    if (
      !current ||
      current.lifecycleState !== 'installed' ||
      current.activationState !== 'enabled' ||
      current.configReadiness !== 'ready' ||
      current.packageDigest !== deps.packageDigest ||
      pkg?.packageState !== 'installed'
    )
      refuse('Neutral installation or capability is no longer current');
  }
  async function current(): Promise<void> {
    deps.assertActivation();
    const snapshot = await deps.inventory.snapshot();
    check(
      snapshot.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId),
      snapshot.packages.find((p) => p.packageDigest === deps.packageDigest),
    );
  }
  const collective = pkg.pluginId === 'official.collective-connector' && instance.pluginId === pkg.pluginId;
  return Object.freeze({
    ...(collective && deps.collectiveMaterialSource
      ? {
          collectiveMaterialSource: createCollectiveMaterialSourceProxy({
            owner: () => deps.collectiveMaterialSource?.current,
            assertCurrent: () => current(),
            ...(deps.activationSignal ? { signal: deps.activationSignal } : {}),
          }),
        }
      : {}),
    members: createPluginMembersHost({ services: deps.members, assertCurrent: current }),
    ...(collective && deps.collectiveArtifactOwner
      ? {
          collectiveArtifactOwner: createCollectiveArtifactOwnerProxy({
            owner: () => deps.collectiveArtifactOwner?.current,
            retainedMedia: () => deps.collectiveArtifactOwner?.retainedMedia,
            pluginInstanceId: deps.pluginInstanceId,
            assertCurrent: () => current(),
            ...(deps.activationSignal ? { signal: deps.activationSignal } : {}),
          }),
        }
      : {}),
  });
}
