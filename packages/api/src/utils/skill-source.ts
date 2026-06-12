import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { readSkillsSyncState } from '../skills/skill-sync-config.js';

function resolveCurrentWorktreeSkillsSource(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return resolve(process.cwd(), 'cat-cafe-skills');
}

/** Canonical Cat Cafe skill source used by capability writeback and drift resolution. */
export async function resolveCatCafeSkillsSource(): Promise<string> {
  return resolveCurrentWorktreeSkillsSource();
}

/**
 * List skill directory names from source root (sorted).
 * Only includes directories containing SKILL.md.
 */
export async function listSourceSkillNames(sourceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const s = await stat(join(sourceRoot, entry.name, 'SKILL.md'));
        if (s.isFile()) names.push(entry.name);
      } catch {
        // No SKILL.md — not a skill directory
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * Compute a manifest hash from the source skills directory.
 * Hash = SHA-256 of sorted skill directory names (those containing SKILL.md).
 * Detects skill additions/removals. Content changes propagate via symlinks.
 */
export async function computeSourceManifestHash(sourceRoot: string): Promise<string> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const skillNames: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const skillMd = join(sourceRoot, entry.name, 'SKILL.md');
      const s = await stat(skillMd);
      if (s.isFile()) skillNames.push(entry.name);
    } catch {
      // No SKILL.md — not a skill directory
    }
  }

  skillNames.sort();
  const digest = createHash('sha256')
    .update(skillNames.join('\n') + '\n')
    .digest('hex')
    .slice(0, 16);
  return `sha256:${digest}`;
}

// ────────── Staleness detection ──────────

export interface SkillsStaleness {
  stale: boolean;
  currentHash: string;
  recordedHash: string | null;
  newSkills: string[];
  removedSkills: string[];
}

/**
 * Compare recorded manifest hash against current source directory.
 * Detects when skills have been added or removed since last sync.
 *
 * F228 three-layer model: staleness is source ↔ global config (registration layer).
 * Pass globalProjectRoot to compare against the global config; defaults to projectRoot
 * for backward compatibility (when the project IS the global project).
 */
export async function checkStaleness(
  projectRoot: string,
  sourceRoot: string,
  globalProjectRoot?: string,
): Promise<SkillsStaleness> {
  const configRoot = globalProjectRoot ?? projectRoot;
  const syncState = await readSkillsSyncState(configRoot);
  const currentHash = await computeSourceManifestHash(sourceRoot);
  const currentNames = await listSourceSkillNames(sourceRoot);
  const config = await readCapabilitiesConfig(configRoot);
  const managedNames =
    config?.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId).map((c) => c.id) ??
    [];

  return {
    stale: syncState === null || syncState.sourceManifestHash !== currentHash,
    currentHash,
    recordedHash: syncState?.sourceManifestHash ?? null,
    newSkills: currentNames.filter((n) => !managedNames.includes(n)),
    removedSkills: managedNames.filter((n) => !currentNames.includes(n)),
  };
}
