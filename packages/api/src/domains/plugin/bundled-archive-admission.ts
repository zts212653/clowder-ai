import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { parseAgentProviderDeclaration } from '../cats/services/agents/session-contract/plugin-agent-provider.js';

/** Distribution does not imply a runtime. Keep builtin modules and ACP data distinct. */
export function bundledArchiveRejection(
  manifest: Pick<PluginManifest, 'runtime'>,
  agentProvider: unknown,
  packageRoot: string,
): string | undefined {
  if (manifest.runtime?.transport === 'builtin') return undefined;
  if (manifest.runtime !== undefined) return 'bundled archive must retain its builtin runtime';
  const result = parseAgentProviderDeclaration(agentProvider, { packageRoot });
  return result.ok ? undefined : `bundled archive requires a valid ACP declaration: ${result.reason}`;
}
