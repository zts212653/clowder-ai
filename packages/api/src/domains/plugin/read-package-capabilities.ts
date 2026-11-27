import { AGENT_ACCESS_DECLARATION_FILE, AGENT_ADAPTER_DECLARATION_FILE } from '@clowder-ai/agent-contract';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { AGENT_PROVIDER_DECLARATION_FILE } from '../cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolvePackageFile } from './declared/declared-resource-paths.js';
import { AgentProviderDeclarationReadError, readDeclaration } from './declared/read-agent-provider-declaration.js';
import { packageCapabilityRejection } from './package-capability-admission.js';

async function readOptionalPackageDeclaration(root: string, filename: string, label: string): Promise<unknown> {
  try {
    return await readDeclaration(await resolvePackageFile(root, filename, label), label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export function readPackageAgentAdapterDeclaration(root: string): Promise<unknown> {
  return readOptionalPackageDeclaration(root, AGENT_ADAPTER_DECLARATION_FILE, 'Agent adapter declaration');
}

/** The locator has already verified archive members and their no-link boundary. */
export async function readPackageCapabilityRejection(
  manifest: PluginManifest,
  root: string,
): Promise<string | undefined> {
  const [provider, access, adapter] = await Promise.all(
    [
      [AGENT_PROVIDER_DECLARATION_FILE, 'Agent provider declaration'],
      [AGENT_ACCESS_DECLARATION_FILE, 'Agent access declaration'],
      [AGENT_ADAPTER_DECLARATION_FILE, 'Agent adapter declaration'],
    ].map(async ([filename, label]) => {
      try {
        return { value: await readOptionalPackageDeclaration(root, filename, label) };
      } catch (error) {
        if (error instanceof AgentProviderDeclarationReadError) return { error: error.message };
        throw error;
      }
    }),
  );
  return (
    provider.error ??
    access.error ??
    adapter.error ??
    packageCapabilityRejection(manifest, provider.value, root, access.value, adapter.value)
  );
}
