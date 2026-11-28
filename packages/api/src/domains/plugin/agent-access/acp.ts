import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { agentAccessAcpModelSelectionResultSchema } from '@clowder-ai/agent-contract/acp';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessAcpModelSelection(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke'>,
) {
  return async ({ configOptions }: { configOptions?: unknown }, model: string) => {
    const offer = Array.isArray(configOptions)
      ? configOptions.find(
          (option: unknown): option is Record<string, unknown> =>
            option !== null &&
            typeof option === 'object' &&
            (('id' in option && option.id === 'model') || ('category' in option && option.category === 'model')),
        )
      : undefined;
    const configId = typeof offer?.id === 'string' ? offer.id.trim() : '';
    if (!configId || offer?.currentValue === model) return null;
    const choices = Array.isArray(offer?.options)
      ? offer.options.flatMap((option: unknown) => {
          const value =
            option !== null && typeof option === 'object' && 'value' in option && typeof option.value === 'string'
              ? option.value.trim()
              : '';
          return value ? [{ value }] : [];
        })
      : [];
    if (choices.length > 0 && !choices.some(({ value }) => value === model)) return null;
    const selected = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (!selected || selected.activationState !== 'enabled' || selected.runtimeState !== 'healthy')
      throw new Error('session_implementation_unavailable');
    const result = await runtime.invoke(selected.pluginInstanceId, 'selectAcpModel', {
      model,
      configOptions: [
        {
          id: configId,
          category: 'model',
          ...(typeof offer?.currentValue === 'string' ? { currentValue: offer.currentValue } : {}),
          options: choices,
        },
      ],
    });
    const current = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
    if (
      current?.pluginInstanceId !== selected.pluginInstanceId ||
      current.packageDigest !== selected.packageDigest ||
      current.lifecycleRevision !== selected.lifecycleRevision ||
      current.runtimeState !== 'healthy'
    )
      throw new Error('session_implementation_unavailable');
    const selection = agentAccessAcpModelSelectionResultSchema.parse(result);
    if (selection && selection.configId !== configId) throw new Error('unapproved_acp_model_option');
    return selection;
  };
}
