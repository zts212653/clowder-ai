import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessKimiLaunch,
  agentAccessKimiEventSchema,
  agentAccessNativeLaunchArgumentsSchema,
} from '@clowder-ai/agent-contract';
import { sanitizeRawEvent } from '../../cats/services/agents/providers/codex-audit-hooks.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessKimiLaunchPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (launch: AgentAccessKimiLaunch) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const result = await runtime.invoke(instance.pluginInstanceId, 'configure', {
      operation: 'plan_native_launch',
      client: 'kimi',
      launch,
    });
    async function assertCurrent() {
      const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (
        current?.pluginInstanceId !== pluginInstanceId ||
        current.packageDigest !== packageDigest ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.runtimeState !== 'healthy'
      )
        throw new Error('session_implementation_unavailable');
    }
    return {
      ...agentAccessNativeLaunchArgumentsSchema.parse(result),
      assertCurrent,
      async normalizeEvent(event: unknown) {
        await assertCurrent();
        const response = await runtime.invoke(instance.pluginInstanceId, 'parseNativeEvent', {
          client: 'kimi',
          event: sanitizeRawEvent(event),
        });
        await assertCurrent();
        return agentAccessKimiEventSchema.parse(response);
      },
    };
  };
}
