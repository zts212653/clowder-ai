import type { AgentAccessClientDirectory, AgentAccessDiscoveryHost } from '@clowder-ai/agent-contract';
import { nativeRuntimeReadiness } from './native-runtime-readiness.js';
import { discoverNativeRuntimes } from './native-runtimes.js';

export const builtInAgentClients: AgentAccessClientDirectory['clients'] = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'Codex' },
  { id: 'google', label: 'Google / AGY Native' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'catagent', label: 'CatAgent' },
  { id: 'acp', label: 'ACP Client' },
];

export async function inspectNativeAccessCandidate(host: AgentAccessDiscoveryHost, id: string, refresh: boolean) {
  const context = await host.readDetectionContext();
  const { runtimes } = await discoverNativeRuntimes(context);
  const target = runtimes.find((runtime) => runtime.id === id);
  if (!target) return { status: 'unavailable' as const };
  return nativeRuntimeReadiness(target, context.projectRoot, refresh, host.inspectNativeLogin);
}
