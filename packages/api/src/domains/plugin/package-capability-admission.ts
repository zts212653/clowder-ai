import { AGENT_ACCESS_PLUGIN_ID, parseAgentAccessDeclaration } from '@clowder-ai/agent-contract';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { parseAgentProviderDeclaration } from '../cats/services/agents/session-contract/plugin-agent-provider.js';

/** Capability admission is independent of catalog, bundled or owner upload provenance. */
export function packageCapabilityRejection(
  manifest: Pick<PluginManifest, 'runtime'> & Partial<Pick<PluginManifest, 'pluginId'>>,
  agentProvider: unknown,
  packageRoot: string,
  agentAccess?: unknown,
): string | undefined {
  if (manifest.runtime && !['builtin', 'stdio'].includes(manifest.runtime.transport))
    return 'Package has no supported Host runtime';

  if (agentProvider !== undefined) {
    const result = parseAgentProviderDeclaration(agentProvider, { packageRoot });
    if (!result.ok) return `Invalid ACP declaration: ${result.reason}`;
  }
  if (agentAccess === undefined)
    return manifest.pluginId === AGENT_ACCESS_PLUGIN_ID ? 'Agent access protocol declaration is missing' : undefined;

  const parsed = parseAgentAccessDeclaration(agentAccess);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.'));
    if (fields.includes('protocolVersion')) return 'Invalid Agent access protocol version';
    return `Invalid Agent access declaration: ${fields.filter(Boolean).join(', ') || 'expected an object'}`;
  }
  if (manifest.runtime?.transport !== 'builtin' || !manifest.runtime.entrypoint)
    return 'Agent access requires an executable plugin module';
}
