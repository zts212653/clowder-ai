import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';

const DEFAULT_ANTIGRAVITY_AGENT_KEY_DIR = join(homedir(), '.cat-cafe', 'agent-keys');
const DEFAULT_ANTIGRAVITY_AGENT_KEY_FILE = join(DEFAULT_ANTIGRAVITY_AGENT_KEY_DIR, 'antigravity.secret');
const DEFAULT_ANTIGRAVITY_CAT_IDS = ['antigravity', 'antig-opus'] as const;

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
    options.userId ?? env.CAT_CAFE_AGENT_KEY_USER_ID?.trim() ?? env.CAT_CAFE_USER_ID?.trim() ?? 'default-user';
  const filePath = options.filePath ?? env.CAT_CAFE_AGENT_KEY_FILE?.trim() ?? DEFAULT_ANTIGRAVITY_AGENT_KEY_FILE;

  const agentKeyIds: Record<string, string> = {};
  const agentKeyFiles: Record<string, string> = {};

  for (const currentCatId of catIds) {
    const currentFilePath =
      options.filePathByCatId?.[currentCatId] ?? defaultFilePathForCatId(catId, filePath, currentCatId);
    const issued = await registry.issue(createCatId(currentCatId), userId);
    await mkdir(dirname(currentFilePath), { recursive: true, mode: 0o700 });
    await writeFile(currentFilePath, `${issued.secret}\n`, { mode: 0o600 });
    await chmod(currentFilePath, 0o600).catch(() => {
      // Best-effort on filesystems that do not support chmod; writeFile(mode)
      // already requested the strict sidecar permission.
    });
    agentKeyIds[currentCatId] = issued.agentKeyId;
    agentKeyFiles[currentCatId] = currentFilePath;
  }

  env.CAT_CAFE_AGENT_KEY_FILE = filePath;
  env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify(agentKeyFiles);
  return { agentKeyId: agentKeyIds[catId] ?? '', agentKeyIds, catId, catIds, userId, filePath, agentKeyFiles };
}
