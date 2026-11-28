import { AGENT_ACCESS_PLUGIN_ID } from '@clowder-ai/agent-contract';
import { createCodexTerminalLoginDriver } from '../../../config/codex-login-driver.js';
import type { PluginRuntimeCarrierRouter } from '../carrier/runtime-carrier.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export function createAgentAccessCodexLoginDriver(
  inventory: Pick<PluginInventoryStore, 'readCurrentAuthority'>,
  runtime: Pick<PluginRuntimeCarrierRouter, 'invoke' | 'nativeActions'>,
) {
  return createCodexTerminalLoginDriver({
    async planLogin(userSignal) {
      const instance = (await inventory.readCurrentAuthority(AGENT_ACCESS_PLUGIN_ID))?.instance;
      if (!instance || instance.activationState !== 'enabled' || instance.runtimeState !== 'healthy')
        throw new Error('session_implementation_unavailable');
      const { pluginInstanceId } = instance;
      const signal = AbortSignal.any([userSignal, runtime.nativeActions.activationSignal(pluginInstanceId)]);
      signal.throwIfAborted();
      const args = await runtime.invoke(pluginInstanceId, 'planCodexLogin', {});
      signal.throwIfAborted();
      return { args, signal };
    },
  });
}
