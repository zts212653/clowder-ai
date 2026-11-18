import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { agentAccessAcpModelSelectionResultSchema } from '@clowder-ai/agent-contract/acp';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessAcpModelSelection(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async ({ configOptions }: { configOptions?: unknown }, model: string) => {
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const result = await runtime.invoke(selected.pluginInstanceId, 'selectAcpModel', { model, configOptions });
    const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (
      current?.pluginInstanceId !== selected.pluginInstanceId ||
      current.packageDigest !== selected.packageDigest ||
      current.lifecycleRevision !== selected.lifecycleRevision ||
      current.runtimeState !== 'healthy'
    )
      throw new Error('session_implementation_unavailable');
    const selection = agentAccessAcpModelSelectionResultSchema.parse(result);
    if (
      selection &&
      !(
        Array.isArray(configOptions) &&
        configOptions.some(
          (option: unknown) =>
            option !== null &&
            typeof option === 'object' &&
            'id' in option &&
            typeof option.id === 'string' &&
            option.id.trim() === selection.configId &&
            (option.id === 'model' || ('category' in option && option.category === 'model')),
        )
      )
    )
      throw new Error('unapproved_acp_model_option');
    return selection;
  };
}
