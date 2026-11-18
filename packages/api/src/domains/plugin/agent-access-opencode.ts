import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessOpenCodeFinalizer,
  type AgentAccessOpenCodeLaunch,
  agentAccessNativeLaunchArgumentsSchema,
  agentAccessOpenCodeEventSchema,
} from '@clowder-ai/agent-contract';
import type { PluginRuntimeCarrierRouter } from './carrier/runtime-carrier.js';
import type { PluginInventoryStore } from './host-inventory/ports.js';

/**
 * Host-side seam for the OpenCode native runtime.
 *
 * Symmetric with the Kimi planner: the Host keeps the binary, credentials, cwd,
 * spawn and the `run --help` probe, and the active package owns argv and event
 * shape. Nothing here re-implements OpenCode's CLI surface — a missing or stale
 * package is an explicit `session_implementation_unavailable`, never a Host-side
 * fallback, because a silent fallback is how one turn runs a different CLI.
 */
export function createAgentAccessOpenCodeLaunchPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (launch: AgentAccessOpenCodeLaunch) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = instance;
    const result = await runtime.invoke(pluginInstanceId, 'configure', {
      operation: 'plan_native_launch',
      client: 'opencode',
      launch,
    });

    // Re-read before every step the Host takes with this plan: a package replaced
    // mid-turn must not keep serving that turn.
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
        return agentAccessOpenCodeEventSchema.parse(
          await runtime.invoke(pluginInstanceId, 'parseNativeEvent', { client: 'opencode', event }),
        );
      },
    };
  };
}

/** The tool-free recovery run: Host-owned continuation, planned by the same package. */
export function createAgentAccessOpenCodeFinalizerPlanner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async (launch: AgentAccessOpenCodeFinalizer) => {
    const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const result = await runtime.invoke(instance.pluginInstanceId, 'planFinalizer', {
      operation: 'plan_native_finalizer',
      client: 'opencode',
      launch,
    });

    return agentAccessNativeLaunchArgumentsSchema.parse(result);
  };
}
