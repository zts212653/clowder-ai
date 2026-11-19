import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessCodexExecLaunch,
  agentAccessCodexExecPlanSchema,
} from '@clowder-ai/agent-contract';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

/**
 * Host-side seam for the Codex exec runtime.
 *
 * Symmetric with the Kimi/OpenCode planners: the Host keeps the executable,
 * credentials, workspace, L0/MCP/image resolution and the spawn. The active
 * package owns exec/resume argv, user-override precedence and display fields.
 * App-server has its own long-lived carrier.
 */
export function createAgentAccessCodexExecLaunchPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (launch: AgentAccessCodexExecLaunch) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const result = await runtime.invoke(pluginInstanceId, 'planCodexExec', {
      operation: 'plan_native_launch',
      client: 'codex',
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
      ...agentAccessCodexExecPlanSchema.parse(result),
      assertCurrent,
    };
  };
}
