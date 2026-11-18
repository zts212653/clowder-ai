import { AGENT_ACCESS_PLUGIN_ID, type AgentAccessDiscoveryHost } from '@clowder-ai/agent-contract';
import { inspectNativeLogin } from '../../routes/native-runtime-readiness.js';
import { nativeRuntimeDetectionContext } from '../../routes/native-runtimes.js';
import { resolveActiveProjectRoot } from '../../utils/active-project-root.js';
import { resolveCliCommand } from '../../utils/cli-resolve.js';
import { currentPluginOwnerRequestContext } from './carrier/plugin-call-context.js';

export function createAgentAccessDiscoveryHost(
  pluginId: string,
  pluginInstanceId: string,
  assertActivation: () => void,
): AgentAccessDiscoveryHost | undefined {
  if (pluginId !== AGENT_ACCESS_PLUGIN_ID) return undefined;
  async function authorize() {
    assertActivation();
    const request = currentPluginOwnerRequestContext(pluginInstanceId);
    if (!request) throw new Error('Agent access requires an authenticated Host request');
    await request.assertCurrent();
  }
  return {
    async readDetectionContext() {
      await authorize();
      return nativeRuntimeDetectionContext(resolveActiveProjectRoot(), true);
    },
    async inspectNativeLogin(client, executable) {
      await authorize();
      if ((client !== 'codex' && client !== 'claude') || executable !== resolveCliCommand(client))
        throw new Error('Agent access login probe requires the installed CLI');
      return inspectNativeLogin(client, executable, resolveActiveProjectRoot());
    },
  };
}
