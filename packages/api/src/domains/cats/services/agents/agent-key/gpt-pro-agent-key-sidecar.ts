import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOwnerUserId } from '../../../../../config/cat-config-loader.js';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';
import { type AgentKeySidecarDisposition, ensureAgentKeySidecar } from './AgentKeySidecarProvisioner.js';

export interface GptProAgentKeySidecarOptions {
  readonly filePath?: string;
  readonly userId?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function expandHomePath(pathValue: string, homeDir: string): string {
  if (pathValue === '~') return homeDir;
  if (pathValue.startsWith('~/')) return join(homeDir, pathValue.slice(2));
  return pathValue;
}

export function resolveGptProAgentKeyFile(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const explicit = env.CAT_CAFE_GPT_PRO_AGENT_KEY_FILE?.trim();
  if (explicit) return expandHomePath(explicit, homeDir);
  const dataDir = expandHomePath(env.CAT_CAFE_DATA_DIR?.trim() || join(homeDir, '.cat-cafe'), homeDir);
  return join(dataDir, 'agent-keys', 'gpt-pro.secret');
}

/**
 * Reconcile gpt-pro without publishing its path into CAT_CAFE_AGENT_KEY_FILES.
 * The shared local-agent MCP map must never contain the cloud cat credential;
 * remote-spike receives a single-entry map in its own scrubbed environment.
 */
export async function ensureGptProAgentKeySidecar(
  registry: AgentKeyRegistry,
  options: GptProAgentKeySidecarOptions = {},
): Promise<AgentKeySidecarDisposition> {
  const env = options.env ?? process.env;
  return ensureAgentKeySidecar({
    registry,
    catId: 'gpt-pro',
    userId: options.userId?.trim() || getOwnerUserId(env),
    keyFile: options.filePath ?? resolveGptProAgentKeyFile(env),
  });
}
