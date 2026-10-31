/**
 * F228 Task 0B: capabilities.json v1 → v2 auto-migration
 *
 * Migrates:
 * - version: 1 → 2
 * - Populates mountPaths per skill from filesystem symlink detection
 *
 * Designed for lazy migration: call when reading a v1 config, then write back v2.
 * Idempotent: v2 configs pass through unchanged.
 */

import { lstat, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CapabilitiesConfig, MountRuleEntry } from '@cat-cafe/shared';
import { DEFAULT_MOUNT_RULES, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';

/**
 * Check if a path is a valid symlink pointing to a specific skill in the source.
 * Returns true if symlink exists and resolves to the expected skill directory.
 * F228: validates exact skill target, not just any path under skillsSource —
 * prevents `.claude/skills/foo -> cat-cafe-skills/bar` from being accepted for `foo`.
 */
async function isValidSkillSymlink(linkPath: string, skillsSource: string, skillName: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const target = await readlink(linkPath);
    const resolved = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
    const normalizedResolved = resolve(resolved);
    const expectedTarget = resolve(join(skillsSource, skillName));
    return normalizedResolved === expectedTarget;
  } catch {
    return false;
  }
}

async function skillSourceExists(skillsSource: string, skillName: string): Promise<boolean> {
  try {
    const stat = await lstat(join(skillsSource, skillName));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isValidDirectoryLevelSkillMount(
  providerSkillsDir: string,
  skillsSource: string,
  skillName: string,
): Promise<boolean> {
  try {
    const stat = await lstat(providerSkillsDir);
    if (!stat.isSymbolicLink()) return false;
    const target = await readlink(providerSkillsDir);
    const resolved = isAbsolute(target) ? target : resolve(dirname(providerSkillsDir), target);
    if (resolve(resolved) !== resolve(skillsSource)) return false;
    return skillSourceExists(skillsSource, skillName);
  } catch {
    return false;
  }
}

async function populateSkillMountPaths(
  projectRoot: string,
  config: CapabilitiesConfig,
  rules: MountRuleEntry[],
  skillsSource: string,
): Promise<void> {
  for (const cap of config.capabilities) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe' || cap.pluginId || cap.mountPaths !== undefined) continue;
    // Disabled skills get empty mountPaths — don't backfill stale symlinks (P2 data invariant)
    if ((cap.globalEnabled ?? cap.enabled) === false) {
      cap.mountPaths = [];
      continue;
    }
    cap.mountPaths = [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const providerSkillsDir = join(projectRoot, rule.path);
      if (await isValidDirectoryLevelSkillMount(providerSkillsDir, skillsSource, cap.id)) {
        cap.mountPaths.push(rule.name);
        continue;
      }
      const linkPath = join(projectRoot, rule.path, cap.id);
      if (await isValidSkillSymlink(linkPath, skillsSource, cap.id)) {
        cap.mountPaths.push(rule.name);
      }
    }
  }
}

/**
 * Migrate a capabilities.json config from v1 to v2.
 *
 * @param projectRoot - Project root directory
 * @param config - Current config (v1 or v2)
 * @param skillsSource - Path to cat-cafe-skills/ source directory
 * @returns Migrated v2 config (or original if already v2)
 */
export async function migrateCapabilitiesV1ToV2(
  projectRoot: string,
  config: CapabilitiesConfig,
  skillsSource: string,
): Promise<CapabilitiesConfig> {
  if (config.version === 2) return config;

  const migrated: CapabilitiesConfig = { ...config, version: 2 };

  // Populate mountPaths for skill entries from filesystem symlinks
  const rules = migrated.mountRules ?? getDefaultMountRuleEntries();
  await populateSkillMountPaths(projectRoot, migrated, rules, skillsSource);

  return migrated;
}

function getDefaultMountRuleEntries(): MountRuleEntry[] {
  return STANDARD_MOUNT_POINT_IDS.map((id) => ({
    name: id,
    path: DEFAULT_MOUNT_RULES.mountPoints[id].path,
    enabled: DEFAULT_MOUNT_RULES.mountPoints[id].enabled,
  }));
}
