import {
  ensureCoreManagedMcps,
  readCapabilitiesConfigState,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from './capability-orchestrator.js';
import { allowsImplicitCapabilityWrites } from './startup-cli-config.js';

/** Bootstrap the host-owned registry before plugins can create a sparse file.
 * Existing files remain authority, including empty, disabled or unreadable
 * configurations. This does not discover/import or rewrite native CLI configs.
 */
export async function initializeFirstRunCapabilities(
  projectRoot: string,
  binaryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: 'initialized' | 'preserved' | 'read_only' | 'unreadable' }> {
  if (!allowsImplicitCapabilityWrites(env)) return { status: 'read_only' };
  return withCapabilityLock(projectRoot, async () => {
    const state = await readCapabilitiesConfigState(projectRoot);
    if (state.kind === 'present') return { status: 'preserved' };
    if (state.kind === 'unreadable') return { status: 'unreadable' };
    const { config } = ensureCoreManagedMcps({ version: 2, capabilities: [] }, { catCafeRepoRoot: binaryRoot });
    await writeCapabilitiesConfig(projectRoot, config);
    return { status: 'initialized' };
  });
}

/** Automatic plugin migration must not turn unknown or explicit empty state
 * into a new default registry. Existing settings remain the repair authority.
 */
export async function readImplicitStartupCapabilities(projectRoot: string, env: NodeJS.ProcessEnv = process.env) {
  if (!allowsImplicitCapabilityWrites(env)) return null;
  const state = await readCapabilitiesConfigState(projectRoot);
  return state.kind === 'present' && state.config.capabilities.length > 0 ? state.config : null;
}
