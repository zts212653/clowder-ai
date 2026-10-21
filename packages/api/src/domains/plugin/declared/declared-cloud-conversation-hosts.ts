import type { CloudConversationHostContribution, StaticContribution } from '@clowder-ai/plugin-contract';
import type { PluginInvocationOutcome } from '../carrier/host-invocation.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import { hostCapabilityRefusal } from '../host-surface/host-capability-refusal.js';
import type { CloudConversationHostLease, CloudConversationHostRegistry } from './cloud-conversation-host-registry.js';

/**
 * F202 W2-3 h3b — the `cloud-conversation-host` contribution, activated like every other runtime
 * contribution: for exactly as long as the package's activation.
 *
 * Everything that can be checked is checked before anything registers, so a package that could
 * not serve fails to enable instead of failing the owner's first message: the Host has a registry,
 * the package holds `cloud.conversation.host`, it runs in-process (only that carrier reports
 * whether a failed call reached the package's action), and it exposes every declared method.
 * Registering is the last step of an activation; the registry refuses a second package for a
 * provider that already has one, and the carrier router then rolls the start back.
 */

export const CLOUD_CONVERSATION_HOST_CAPABILITY = 'cloud.conversation.host';

/** What the router lends a declared contribution besides invoke. */
export interface DeclaredActionSurface {
  attempt(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome>;
  exposes(pluginInstanceId: string, method: string): Promise<boolean>;
}

export function isCloudConversationHost(value: StaticContribution): value is CloudConversationHostContribution {
  return value.type === 'cloud-conversation-host';
}

function declaredMethods(host: CloudConversationHostContribution): readonly string[] {
  return [host.appendMessage.method, host.assistantReturns.list.method, host.assistantReturns.ack.method];
}

export async function admitCloudConversationHosts(
  admission: PluginRuntimeAdmission,
  hosts: readonly CloudConversationHostContribution[],
  registry: CloudConversationHostRegistry | undefined,
  surface: DeclaredActionSurface | undefined,
): Promise<void> {
  if (hosts.length === 0) return;
  const { pluginId, manifest } = admission.packageRecord;
  if (!registry || !surface) {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host cloud conversation registry is unavailable');
  }
  if (!admission.effectiveGrants.includes(CLOUD_CONVERSATION_HOST_CAPABILITY)) {
    throw hostCapabilityRefusal(
      new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginId} lacks ${CLOUD_CONVERSATION_HOST_CAPABILITY}`),
      CLOUD_CONVERSATION_HOST_CAPABILITY,
    );
  }
  if (manifest.runtime?.transport !== 'builtin') {
    throw new ExternalPluginRuntimeError(
      'UNSUPPORTED_TRANSPORT',
      `${pluginId} can host cloud conversations only as an in-process module`,
    );
  }
  for (const host of hosts) {
    for (const method of declaredMethods(host)) {
      if (!(await surface.exposes(admission.instance.pluginInstanceId, method))) {
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `${pluginId} declares ${method} for ${host.id} but does not expose it`,
        );
      }
    }
  }
}

/** Registers each host, pushing every lease as soon as it exists so a rollback can release it. */
export function registerCloudConversationHosts(
  admission: PluginRuntimeAdmission,
  hosts: readonly CloudConversationHostContribution[],
  registry: CloudConversationHostRegistry | undefined,
  surface: DeclaredActionSurface | undefined,
  leases: CloudConversationHostLease[],
): void {
  if (hosts.length === 0 || !registry || !surface) return;
  const pluginInstanceId = admission.instance.pluginInstanceId;
  for (const contribution of hosts) {
    leases.push(
      registry.register({
        provider: contribution.provider,
        pluginId: admission.packageRecord.pluginId,
        pluginInstanceId,
        contribution,
        attempt: (method, params) => surface.attempt(pluginInstanceId, method, params),
      }),
    );
  }
}
