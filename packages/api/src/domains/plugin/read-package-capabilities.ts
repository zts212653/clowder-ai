import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { AGENT_PROVIDER_DECLARATION_FILE } from '../cats/services/agents/session-contract/plugin-agent-provider.js';
import { resolvePackageFile } from './declared/declared-resource-paths.js';
import { AgentProviderDeclarationReadError, readDeclaration } from './declared/read-agent-provider-declaration.js';
import { packageCapabilityRejection } from './package-capability-admission.js';

/** The locator has already verified archive members and their no-link boundary. */
export async function readPackageCapabilityRejection(
  manifest: PluginManifest,
  root: string,
): Promise<string | undefined> {
  let declaration: unknown;
  try {
    declaration = await readDeclaration(
      await resolvePackageFile(root, AGENT_PROVIDER_DECLARATION_FILE, 'Agent provider declaration'),
    );
  } catch (error) {
    if (error instanceof AgentProviderDeclarationReadError) return error.message;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return packageCapabilityRejection(manifest, declaration, root);
}
