import {
  AGENT_ACCESS_PLUGIN_ID,
  type AgentAccessA2ARunner,
  agentAccessA2AEventsSchema,
} from '@clowder-ai/agent-contract';
import type { PluginRuntimeCarrierRouter } from './carrier/runtime-carrier.js';
import type { PluginInventoryStore } from './host-inventory/ports.js';

export function createAgentAccessA2ARunner(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
): AgentAccessA2ARunner {
  return async (input, submit) => {
    const authority = await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID);
    const active = authority?.instance;
    if (!active || active.activationState !== 'enabled' || active.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');

    const { pluginInstanceId, packageDigest, lifecycleRevision } = active;
    let sent = false;
    const value = await runtime.invoke(pluginInstanceId, 'startTurn', {
      input,
      async submit(request: string) {
        const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
        if (
          current?.pluginInstanceId !== pluginInstanceId ||
          current.packageDigest !== packageDigest ||
          current.lifecycleRevision !== lifecycleRevision ||
          current.runtimeState !== 'healthy'
        )
          throw new Error('session_implementation_unavailable');
        if (sent) throw new Error('A2A request already dispatched');
        sent = true;
        return submit(request);
      },
    });

    const events = agentAccessA2AEventsSchema.parse(value);
    return events.map((event) => ({ ...event, catId: input.catId }));
  };
}
