import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginInventoryStore } from '../../host-inventory/ports.js';

export interface CurrentPluginTaskDataControllerAuthority {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly moduleRef: string;
  readonly lifecycleRevision: number;
  readonly grantRevision: number;
  readonly effectiveGrants: readonly string[];
}

/** Host-only stores and fences. This object never crosses the module boundary. */
export interface PluginTaskAdmissionServices {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'appendIdempotent'>;
  isCatAvailable(catId: string): boolean;
  /** The activation, installed package and granted authority must still be current. */
  assertCurrent(): Promise<void>;
  /** Read-only live projection. Absence means this installation cannot currently maintain Task data. */
  readCurrentDataControllerAuthority(): Promise<CurrentPluginTaskDataControllerAuthority | undefined>;
  /** Serialize a Task controller mutation with installation lifecycle and grant changes. */
  withCurrentDataControllerAuthority<T>(
    run: (authority: CurrentPluginTaskDataControllerAuthority) => Promise<T>,
  ): Promise<T>;
}
export async function createPluginTaskAdmissionServices(deps: {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly inventory: PluginInventoryStore;
  readonly messageStore: PluginTaskAdmissionServices['messageStore'];
  readonly assertActivation: () => void;
  readonly isCatAvailable: (catId: string) => boolean;
}): Promise<PluginTaskAdmissionServices> {
  const initial = await deps.inventory.snapshot();
  const instance = initial.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId);
  const grant = initial.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId);
  if (!instance || !grant || instance.packageDigest !== deps.packageDigest) refuse('Task installation unavailable');
  // Config saves advance the inventory revision without replacing this activation.
  // Keep its starting revision as the durable controller epoch; assertActivation owns
  // stop/restart invalidation, while package and grant fences remain live inventory checks.
  const grantRevision = grant.grantRevision;
  const activationLifecycleRevision = instance.lifecycleRevision;
  const pluginId = instance.pluginId;
  const requiredGrants = ['task.read', 'task.write', 'task.admitEntrusted'] as const;
  const authority = (effectiveGrants: readonly string[]): CurrentPluginTaskDataControllerAuthority => ({
    pluginId,
    pluginInstanceId: deps.pluginInstanceId,
    moduleRef: `plugin:${pluginId}`,
    lifecycleRevision: activationLifecycleRevision,
    grantRevision,
    effectiveGrants: [...effectiveGrants],
  });
  const currentDataControllerAuthority = (
    live: typeof instance | undefined,
    current: typeof instance | undefined,
    grants: typeof grant | undefined,
    packageState: string | undefined,
  ): CurrentPluginTaskDataControllerAuthority | undefined => {
    if (
      !live ||
      current?.pluginInstanceId !== deps.pluginInstanceId ||
      live.lifecycleState !== 'installed' ||
      live.activationState !== 'enabled' ||
      live.configReadiness !== 'ready' ||
      live.packageDigest !== deps.packageDigest ||
      packageState !== 'installed' ||
      grants?.grantRevision !== grantRevision ||
      requiredGrants.some((required) => !grants.effectiveGrants.includes(required))
    ) {
      return undefined;
    }
    return authority(grants.effectiveGrants);
  };
  return Object.freeze({
    messageStore: deps.messageStore,
    isCatAvailable: deps.isCatAvailable,
    async assertCurrent() {
      deps.assertActivation();
      const snapshot = await deps.inventory.snapshot();
      deps.assertActivation();
      const live = snapshot.instances.find((i) => i.pluginInstanceId === deps.pluginInstanceId);
      const grants = snapshot.grants.find((g) => g.pluginInstanceId === deps.pluginInstanceId);
      const pkg = snapshot.packages.find((p) => p.packageDigest === deps.packageDigest);
      if (
        !live ||
        snapshot.instances.find(
          (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
        )?.pluginInstanceId !== deps.pluginInstanceId ||
        live.lifecycleState !== 'installed' ||
        live.activationState !== 'enabled' ||
        live.configReadiness !== 'ready' ||
        live.packageDigest !== deps.packageDigest ||
        pkg?.packageState !== 'installed' ||
        grants?.grantRevision !== grantRevision ||
        !grants.effectiveGrants.includes('task.admitEntrusted')
      )
        refuse('Task installation or admission capability is no longer current');
    },
    async readCurrentDataControllerAuthority() {
      deps.assertActivation();
      const snapshot = await deps.inventory.snapshot();
      deps.assertActivation();
      const live = snapshot.instances.find((candidate) => candidate.pluginInstanceId === deps.pluginInstanceId);
      const current = snapshot.instances.find(
        (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
      );
      const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === deps.pluginInstanceId);
      const pkg = snapshot.packages.find((candidate) => candidate.packageDigest === deps.packageDigest);
      return currentDataControllerAuthority(live, current, grants, pkg?.packageState);
    },
    async withCurrentDataControllerAuthority<T>(
      run: (current: CurrentPluginTaskDataControllerAuthority) => Promise<T>,
    ) {
      deps.assertActivation();
      return deps.inventory.transaction(async (transaction) => {
        deps.assertActivation();
        const live = transaction.instances.get(deps.pluginInstanceId);
        const current = transaction.instances.getCurrent(pluginId);
        const grants = transaction.grants.get(deps.pluginInstanceId);
        const pkg = transaction.packages.get(deps.packageDigest);
        const verified = currentDataControllerAuthority(live, current, grants, pkg?.packageState);
        if (!verified) {
          refuse('Task installation or data-controller capability is no longer current');
        }
        return run(verified);
      });
    },
  });
}
function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}
