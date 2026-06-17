import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { SignalSourceConfig } from '@cat-cafe/shared';
import { SignalSourceConfigSchema } from '@cat-cafe/shared';
import { parse, stringify } from 'yaml';
import { DEFAULT_SIGNAL_SOURCES } from './default-sources.js';
import type { SignalPaths } from './signal-paths.js';
import { resolveSignalPaths } from './signal-paths.js';

const SOURCE_FILE_BANNER = '# Clowder AI Signal Hunter sources config\n';

function toYaml(config: SignalSourceConfig): string {
  return `${SOURCE_FILE_BANNER}${stringify(config)}`;
}

async function writeDefaultSourcesFile(paths: SignalPaths): Promise<void> {
  await writeFile(paths.sourcesFile, toYaml(DEFAULT_SIGNAL_SOURCES), 'utf-8');
}

export async function ensureSignalWorkspace(paths: SignalPaths = resolveSignalPaths()): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  await mkdir(paths.libraryDir, { recursive: true });
  await mkdir(paths.inboxDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  if (!existsSync(paths.sourcesFile)) {
    await writeDefaultSourcesFile(paths);
  }
}

function parseAndValidateSources(yamlText: string): SignalSourceConfig {
  const parsed = parse(yamlText) as unknown;
  const result = SignalSourceConfigSchema.safeParse(parsed);

  if (!result.success) {
    const detail = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid signal sources config: ${detail}`);
  }

  return result.data as SignalSourceConfig;
}

/** Append-only merge: new defaults are added, but existing sources keep their
 *  persisted state (enabled/disabled, custom fields). Defaults whose fields
 *  changed (e.g. URL update) will NOT overwrite the persisted copy. */
function mergeWithDefaults(existing: SignalSourceConfig): SignalSourceConfig {
  const existingIds = new Set(existing.sources.map((s) => s.id));
  const newSources = DEFAULT_SIGNAL_SOURCES.sources.filter((s) => !existingIds.has(s.id));

  if (newSources.length === 0) return existing;

  return {
    ...existing,
    sources: [...existing.sources, ...newSources],
  };
}

export async function loadSignalSources(paths: SignalPaths = resolveSignalPaths()): Promise<SignalSourceConfig> {
  await ensureSignalWorkspace(paths);

  const yamlText = await readFile(paths.sourcesFile, 'utf-8');
  if (yamlText.trim().length === 0) {
    await writeDefaultSourcesFile(paths);
    return DEFAULT_SIGNAL_SOURCES;
  }

  const persisted = parseAndValidateSources(yamlText);
  const merged = mergeWithDefaults(persisted);

  if (merged !== persisted) {
    await writeFile(paths.sourcesFile, toYaml(merged), 'utf-8');
  }

  return merged;
}

export async function saveSignalSources(
  config: SignalSourceConfig,
  paths: SignalPaths = resolveSignalPaths(),
): Promise<void> {
  await ensureSignalWorkspace(paths);
  const validated = SignalSourceConfigSchema.parse(config) as SignalSourceConfig;
  await writeFile(paths.sourcesFile, toYaml(validated), 'utf-8');
}

export { resolveSignalPaths };
export type { SignalPaths };
