import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { parseAgentProviderDeclaration } from '../cats/services/agents/session-contract/plugin-agent-provider.js';

/** Capability admission is independent of catalog, bundled or owner upload provenance. */
export function packageCapabilityRejection(
  manifest: Pick<PluginManifest, 'runtime'>,
  agentProvider: unknown,
  packageRoot: string,
): string | undefined {
  if (manifest.runtime && !['builtin', 'stdio'].includes(manifest.runtime.transport))
    return 'Package has no supported Host runtime';
  if (agentProvider === undefined) return undefined;
  const result = parseAgentProviderDeclaration(agentProvider, { packageRoot });
  return result.ok ? undefined : `Invalid ACP declaration: ${result.reason}`;
}
