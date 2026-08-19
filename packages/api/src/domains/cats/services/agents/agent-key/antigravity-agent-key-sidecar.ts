import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';
import { ensureAgentKeySidecar } from './AgentKeySidecarProvisioner.js';

const DEFAULT_ANTIGRAVITY_AGENT_KEY_DIR = join(homedir(), '.cat-cafe', 'agent-keys');
const DEFAULT_ANTIGRAVITY_AGENT_KEY_FILE = join(DEFAULT_ANTIGRAVITY_AGENT_KEY_DIR, 'antigravity.secret');
// The global Antigravity/agy MCP process is shared by every cat whose CLI carrier is `agy`.
const DEFAULT_ANTIGRAVITY_CAT_IDS = [
  'antigravity',
  'antig-opus',
  'agy-opus',
  'gemini',
  'gemini25',
  'gemini35',
] as const;

export interface AntigravityAgentKeySidecarOptions {
  catId?: string;
  catIds?: readonly string[];
  userId?: string;
  filePath?: string;
  filePathByCatId?: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
}

export interface AntigravityAgentKeySidecarResult {
  agentKeyId: string;
  agentKeyIds: Record<string, string>;
  catId: string;
  catIds: string[];
  userId: string;
  filePath: string;
  agentKeyFiles: Record<string, string>;
}

function uniqueCatIds(defaultCatId: string, catIds?: readonly string[]): string[] {
  const source = catIds ?? (defaultCatId === 'antigravity' ? DEFAULT_ANTIGRAVITY_CAT_IDS : [defaultCatId]);
  return [...new Set([defaultCatId, ...source].map((value) => value.trim()).filter(Boolean))];
}

function defaultFilePathForCatId(defaultCatId: string, defaultFilePath: string, catId: string): string {
  if (catId === defaultCatId) return defaultFilePath;
  return join(dirname(defaultFilePath), `${catId}.secret`);
}

export async function ensureAntigravityAgentKeySidecar(
  registry: AgentKeyRegistry,
  options: AntigravityAgentKeySidecarOptions = {},
): Promise<AntigravityAgentKeySidecarResult> {
  const env = options.env ?? process.env;
  const catId = options.catId ?? 'antigravity';
  const catIds = uniqueCatIds(catId, options.catIds);
  const userId =
    options.userId?.trim() || env.CAT_CAFE_AGENT_KEY_USER_ID?.trim() || env.CAT_CAFE_USER_ID?.trim() || 'default-user';
  const filePath = options.filePath ?? env.CAT_CAFE_AGENT_KEY_FILE?.trim() ?? DEFAULT_ANTIGRAVITY_AGENT_KEY_FILE;

  const agentKeyIds: Record<string, string> = {};
  const agentKeyFiles: Record<string, string> = {};

  for (const currentCatId of catIds) {
    const currentFilePath =
      options.filePathByCatId?.[currentCatId] ?? defaultFilePathForCatId(catId, filePath, currentCatId);
    const reconciled = await ensureAgentKeySidecar({
      registry,
      catId: currentCatId,
      userId,
      keyFile: currentFilePath,
    });
    agentKeyIds[currentCatId] = reconciled.agentKeyId;
    agentKeyFiles[currentCatId] = currentFilePath;
  }

  env.CAT_CAFE_AGENT_KEY_FILE = filePath;
  env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify(agentKeyFiles);
  return { agentKeyId: agentKeyIds[catId] ?? '', agentKeyIds, catId, catIds, userId, filePath, agentKeyFiles };
}
