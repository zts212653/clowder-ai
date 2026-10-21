import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginInventoryStore } from '../../host-inventory/ports.js';

/** Host-only stores and fences. This object never crosses the module boundary. */
export interface PluginTaskAdmissionServices {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey' | 'appendIdempotent'>;
  isCatAvailable(catId: string): boolean;
  /** The activation, installed package and granted authority must still be current. */
  assertCurrent(): Promise<void>;
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
  const grantRevision = grant.grantRevision;
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
        live.lifecycleState !== 'installed' ||
        live.activationState !== 'enabled' ||
        live.configReadiness !== 'ready' ||
        live.packageDigest !== deps.packageDigest ||
        pkg?.packageState !== 'installed' ||
        grants?.grantRevision !== grantRevision ||
        !grants.effectiveGrants.some((g: string) => g === 'task.admitEntrusted')
      )
        refuse('Task installation or admission capability is no longer current');
    },
  });
}
function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}
