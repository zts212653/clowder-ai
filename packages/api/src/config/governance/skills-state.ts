/**
 * ADR-025 / F228: Skills sync state helpers
 *
 * capabilities.json is the single truth source:
 *   - capabilities[].source === 'cat-cafe' identifies managed skills
 *   - capabilities.json#skillsSync tracks source hash/timestamp
 *   - capabilities[].mountPaths tracks intended project/provider mounts
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillsSyncState } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../capabilities/capability-orchestrator.js';

/**
 * Read sync state from capabilities.json#skillsSync.
 * Returns null if the selected project has not synced yet.
 */
export async function readSkillsSyncState(projectRoot: string): Promise<SkillsSyncState | null> {
  const config = await readCapabilitiesConfig(projectRoot);
  if (config?.skillsSync) {
    const s = config.skillsSync;
    if (
      typeof s.sourceRoot === 'string' &&
      typeof s.sourceManifestHash === 'string' &&
      typeof s.lastSyncedAt === 'string'
    ) {
      return s;
    }
  }
  return null;
}

/**
 * Write sync state to capabilities.json#skillsSync.
 * Creates capabilities.json if it doesn't exist.
 */
export async function writeSkillsSyncState(projectRoot: string, syncState: SkillsSyncState): Promise<void> {
  let config = await readCapabilitiesConfig(projectRoot);
  if (!config) {
    config = { version: 2, capabilities: [] };
  }
  if (config.version === 1) {
    config.version = 2;
  }
  config.skillsSync = syncState;
  await writeCapabilitiesConfig(projectRoot, config);
}

/**
 * Update mountPaths for specific skills in capabilities.json.
 * Sets mountPaths to the given provider names for each skill.
 */
export async function updateSkillMountPaths(
  projectRoot: string,
  skillNames: string[],
  providerNames: string[],
  opts?: { forceDisabled?: boolean; forceEnabled?: boolean },
): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const nameSet = new Set(skillNames);
  // F228 mountPaths = faithful record of current mount state.
  // forceDisabled: cascade disable → enabled:false, mountPaths:[]
  // forceEnabled: cascade re-enable → enabled:true, mountPaths = caller-provided list
  // Normal: providerNames non-empty → update; empty + no force → preserve existing state
  const resolvedEnabled =
    opts?.forceDisabled === true ? false : opts?.forceEnabled === true ? true : providerNames.length > 0 || undefined;
  const isCatCafeSkill = (cap: (typeof config.capabilities)[number]) =>
    cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId;
  const existingIds = new Set(config.capabilities.filter(isCatCafeSkill).map((c) => c.id));

  // Update existing entries
  for (const cap of config.capabilities) {
    if (isCatCafeSkill(cap) && nameSet.has(cap.id)) {
      if (resolvedEnabled !== undefined) {
        cap.enabled = resolvedEnabled;
        // F228: mountPaths always written as explicit list — never undefined.
        // Callers are responsible for passing the correct mount point list
        // (all active mount points for re-enable/new-skill, specific list for policy).
        cap.mountPaths = [...providerNames];
      }
      // else: empty providers, not force-disabled/enabled → preserve existing state.
      nameSet.delete(cap.id);
    }
  }

  // Upsert: create missing skill entries (e.g. first sync after drift detection)
  for (const skillName of nameSet) {
    if (!existingIds.has(skillName)) {
      config.capabilities.push({
        id: skillName,
        type: 'skill',
        source: 'cat-cafe',
        enabled: resolvedEnabled ?? true,
        // F228: mountPaths always explicit — caller provides the list of mount points.
        mountPaths: [...providerNames],
      });
    }
  }

  await writeCapabilitiesConfig(projectRoot, config);
}

/**
 * Remove source-tree Cat Cafe skill capabilities that no longer exist.
 * Plugin-owned skill capabilities are intentionally preserved: their source
 * lives outside cat-cafe-skills and is reconciled by the plugin lifecycle.
 */
export async function removeCatCafeSkillCapabilities(projectRoot: string, skillNames: string[]): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const nameSet = new Set(skillNames);
  const before = config.capabilities.length;
  config.capabilities = config.capabilities.filter(
    (cap) => !(cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && nameSet.has(cap.id)),
  );
  if (config.capabilities.length !== before) {
    await writeCapabilitiesConfig(projectRoot, config);
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
  // Trailing newline matches bash `printf '%s\n' | sort | shasum`
  const digest = createHash('sha256')
    .update(skillNames.join('\n') + '\n')
    .digest('hex')
    .slice(0, 16);
  return `sha256:${digest}`;
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

// --- ADR-025 Phase 2: Stale Detection ---

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
 */
export async function checkStaleness(projectRoot: string, sourceRoot: string): Promise<SkillsStaleness> {
  const syncState = await readSkillsSyncState(projectRoot);
  const currentHash = await computeSourceManifestHash(sourceRoot);
  const currentNames = await listSourceSkillNames(sourceRoot);
  const config = await readCapabilitiesConfig(projectRoot);
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
