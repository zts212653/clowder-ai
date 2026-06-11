/**
 * Mount Rules Reconciliation — F228
 *
 * Pure reconciliation logic extracted from routes/mount-rules.ts.
 * Handles filesystem symlink reconciliation when mount rules change.
 */

import { lstat, readdir, readlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type CapabilityEntry, type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { GovernanceRegistry } from '../config/governance/governance-registry.js';
import { listSourceSkillNames } from '../config/governance/skills-state.js';
import { readProjectMountRulesOverride } from '../config/mount/mount-rules-store.js';
import { resolvePluginSkillSourcesForProject } from '../utils/plugin-skill-source.js';
import { pathsEqual } from '../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import { resolveCatCafeSkillsSource } from '../utils/skill-source.js';
import { filterRulesToProvider, mountSkillForProject, unmountSkillForProject } from '../utils/skill-symlink-writer.js';

/* ---------- private helpers ---------- */

function resolveSymlinkTarget(linkPath: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(linkPath), target);
}

async function isManagedSkillSymlink(linkPath: string, skillsSource: string, skillName: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const target = resolveSymlinkTarget(linkPath, await readlink(linkPath));
    return pathsEqual(resolve(target), resolve(skillsSource, skillName));
  } catch {
    return false;
  }
}

async function listManagedSkillSymlinkNames(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const id of STANDARD_PROVIDER_IDS) {
    if (!rules.providers[id].enabled) continue;
    const skillsDir = join(projectRoot, rules.providers[id].path);
    try {
      const stat = await lstat(skillsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(skillsDir);
    } catch {
      continue;
    }
    for (const entryName of entries) {
      if (await isManagedSkillSymlink(join(skillsDir, entryName), skillsSource, entryName)) {
        names.add(entryName);
      }
    }
  }
  return names;
}

function customSkillDirsForRules(projectRoot: string, rules: MountRules): string[] {
  return [
    ...new Set(
      buildSkillMountTargets(projectRoot, homedir(), rules)
        .filter((target) => target.kind === 'custom')
        .flatMap((target) => target.candidates),
    ),
  ];
}

async function listCustomManagedSkillSymlinkNames(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const skillsDir of customSkillDirsForRules(projectRoot, rules)) {
    try {
      const stat = await lstat(skillsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(skillsDir);
    } catch {
      continue;
    }
    for (const entryName of entries) {
      if (await isManagedSkillSymlink(join(skillsDir, entryName), skillsSource, entryName)) {
        names.add(entryName);
      }
    }
  }
  return names;
}

async function removeManagedDirectoryLevelSkillsSymlinksForRules(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
): Promise<void> {
  for (const id of STANDARD_PROVIDER_IDS) {
    if (!rules.providers[id].enabled) continue;
    const skillsDir = join(projectRoot, rules.providers[id].path);
    let isManagedRoot = false;
    try {
      isManagedRoot = await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource);
    } catch {
      // Invalid directory-level symlinks are user-owned blockers; leave them for drift/conflict handling.
    }
    if (isManagedRoot) await unlink(skillsDir);
  }
}

async function removeManagedDirectoryLevelSkillsSymlinksForCustomRules(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
): Promise<void> {
  for (const skillsDir of customSkillDirsForRules(projectRoot, rules)) {
    let isManagedRoot = false;
    try {
      isManagedRoot = await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource);
    } catch {
      // Invalid directory-level symlinks are user-owned blockers; leave them for drift/conflict handling.
    }
    if (isManagedRoot) await unlink(skillsDir);
  }
}

function mountableProviderIdsForRules(rules: MountRules): Set<string> {
  const providerIds = new Set<string>();
  for (const id of STANDARD_PROVIDER_IDS) {
    if (rules.providers[id].enabled) providerIds.add(id);
  }
  for (const entry of rules.customPaths ?? []) {
    providerIds.add(entry.alias);
  }
  return providerIds;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * F228: Prune mountPaths to only include currently mountable provider IDs.
 * mountPaths = target mount policy. When a mount point is disabled, it is
 * removed from mountPaths — even if that makes mountPaths empty (the skill
 * stays enabled:true but has no active mounts). The restore logic
 * (restoreNewlyEnabledMountPoints) adds mount points back on re-enable.
 */
function pruneCapabilityMountPaths(cap: CapabilityEntry, mountableProviderIds: ReadonlySet<string>): boolean {
  if (cap.type !== 'skill' || cap.source !== 'cat-cafe') return false;
  if (cap.pluginId && cap.enabled !== false && Array.isArray(cap.mountPaths) && cap.mountPaths.length === 0) {
    return false;
  }

  const nextMountPaths =
    cap.enabled === false
      ? []
      : Array.isArray(cap.mountPaths)
        ? [...new Set(cap.mountPaths.filter((providerId) => mountableProviderIds.has(providerId)))]
        : [...mountableProviderIds];
  let dirty = false;
  if (!sameStringArray(cap.mountPaths ?? [], nextMountPaths)) {
    cap.mountPaths = nextMountPaths;
    dirty = true;
  }
  return dirty;
}

/**
 * F228 Scenario 9/11: Restore newly-enabled standard mount points to all enabled skills.
 * When a STANDARD mount point transitions from disabled→enabled, add it to every
 * enabled skill's mountPaths so the skill gets mounted there.
 *
 * Only standard provider IDs (claude/codex/gemini/kimi) are restored. Custom paths
 * being added to mount rules are "new mount points", not "re-enabled" — they require
 * explicit user configuration per skill.
 */
function restoreNewlyEnabledMountPoints(
  capabilities: CapabilityEntry[],
  previousMountable: ReadonlySet<string>,
  nextMountable: ReadonlySet<string>,
): boolean {
  const standardProviderIds = new Set<string>(STANDARD_PROVIDER_IDS);
  const newlyEnabled = [...nextMountable].filter((id) => !previousMountable.has(id) && standardProviderIds.has(id));
  if (newlyEnabled.length === 0) return false;

  let dirty = false;
  for (const cap of capabilities) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe') continue;
    if (cap.pluginId) continue;
    if (cap.enabled === false) continue;

    if (Array.isArray(cap.mountPaths)) {
      const toAdd = newlyEnabled.filter((id) => !cap.mountPaths!.includes(id));
      if (toAdd.length > 0) {
        cap.mountPaths = [...cap.mountPaths, ...toAdd];
        dirty = true;
      }
    } else {
      // mountPaths was undefined (legacy) — materialize to full list
      cap.mountPaths = [...nextMountable];
      dirty = true;
    }
  }
  return dirty;
}

function resolveCapabilityMountPolicy(cap: CapabilityEntry | undefined): {
  enabled: boolean;
  providerIds?: readonly string[];
} {
  if (!cap) return { enabled: true };
  if (cap.enabled === false) return { enabled: false, providerIds: [] };
  if (Array.isArray(cap.mountPaths)) return { enabled: cap.mountPaths.length > 0, providerIds: cap.mountPaths };
  return { enabled: true };
}

async function mountSkillForPolicy(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  rules: MountRules,
  providerIds?: readonly string[],
): Promise<void> {
  if (!providerIds) {
    await mountSkillForProject(projectRoot, skillName, skillsSource, rules);
    return;
  }
  for (const providerId of providerIds) {
    await mountSkillForProject(projectRoot, skillName, skillsSource, filterRulesToProvider(rules, providerId));
  }
}

/* ---------- exported reconciliation functions ---------- */

/**
 * Reconcile skill symlinks after a mount-rules change for a single project.
 *
 * @param pluginsDir — absolute path to the plugins directory (typically
 *   `join(STARTUP_PROJECT_ROOT, 'plugins')`). Passed explicitly so this
 *   module stays free of route-level constants.
 */
export async function reconcileSkillMountsAfterRuleChange(
  projectRoot: string,
  previousRules: MountRules,
  nextRules: MountRules,
  pluginsDir: string,
): Promise<void> {
  const skillsSource = await resolveCatCafeSkillsSource();
  const skillNames = await listSourceSkillNames(skillsSource);
  const sourceSkillSet = new Set(skillNames);
  await removeManagedDirectoryLevelSkillsSymlinksForRules(projectRoot, skillsSource, previousRules);
  await removeManagedDirectoryLevelSkillsSymlinksForRules(projectRoot, skillsSource, nextRules);
  await removeManagedDirectoryLevelSkillsSymlinksForCustomRules(projectRoot, skillsSource, previousRules);
  await removeManagedDirectoryLevelSkillsSymlinksForCustomRules(projectRoot, skillsSource, nextRules);
  const staleManagedSkillNames = new Set([
    ...(await listManagedSkillSymlinkNames(projectRoot, skillsSource, previousRules)),
    ...(await listManagedSkillSymlinkNames(projectRoot, skillsSource, nextRules)),
    ...(await listCustomManagedSkillSymlinkNames(projectRoot, skillsSource, previousRules)),
    ...(await listCustomManagedSkillSymlinkNames(projectRoot, skillsSource, nextRules)),
  ]);
  const config = await readCapabilitiesConfig(projectRoot);
  const previousMountable = mountableProviderIdsForRules(previousRules);
  const mountableProviderIds = mountableProviderIdsForRules(nextRules);
  let configDirty = false;
  // F228 Scenario 8/10: Prune disabled mount points from skill mountPaths
  for (const cap of config?.capabilities ?? []) {
    configDirty = pruneCapabilityMountPaths(cap, mountableProviderIds) || configDirty;
  }
  // F228 Scenario 9/11: Add newly-enabled mount points to enabled skills
  if (config) {
    configDirty =
      restoreNewlyEnabledMountPoints(config.capabilities, previousMountable, mountableProviderIds) || configDirty;
  }
  const catCafeSkillCaps = new Map(
    config?.capabilities
      .filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId)
      .map((cap) => [cap.id, cap]) ?? [],
  );

  for (const skillName of skillNames) {
    await unmountSkillForProject(projectRoot, skillName, previousRules, skillsSource, { enabledOnly: true });
    await unmountSkillForProject(projectRoot, skillName, nextRules, skillsSource, { enabledOnly: true });
  }
  for (const skillName of staleManagedSkillNames) {
    if (sourceSkillSet.has(skillName)) continue;
    await unmountSkillForProject(projectRoot, skillName, previousRules, skillsSource);
    await unmountSkillForProject(projectRoot, skillName, nextRules, skillsSource);
  }
  for (const skillName of skillNames) {
    const policy = resolveCapabilityMountPolicy(catCafeSkillCaps.get(skillName));
    if (!policy.enabled) continue;
    await mountSkillForPolicy(projectRoot, skillName, skillsSource, nextRules, policy.providerIds);
  }

  // F228: Reconcile plugin skills — unmount from old rules, remount under new rules.
  // Plugin skills use the same mount/unmount primitives but resolve their source
  // from plugin manifests instead of the cat-cafe-skills tree.
  // Collect warnings instead of silently swallowing errors — stale plugin
  // symlinks remaining on disk after a failed unmount should be surfaced.
  const pluginSkills = resolvePluginSkillSourcesForProject(config, pluginsDir, projectRoot);
  const pluginWarnings: string[] = [];
  for (const ps of pluginSkills) {
    await unmountSkillForProject(projectRoot, ps.skillName, previousRules, ps.skillsSource).catch((err) => {
      pluginWarnings.push(
        `Failed to unmount plugin skill '${ps.skillName}' (previous rules): ${(err as Error).message}`,
      );
    });
    await unmountSkillForProject(projectRoot, ps.skillName, nextRules, ps.skillsSource).catch((err) => {
      pluginWarnings.push(`Failed to unmount plugin skill '${ps.skillName}' (next rules): ${(err as Error).message}`);
    });
    if (ps.enabled) {
      await mountSkillForPolicy(projectRoot, ps.skillName, ps.skillsSource, nextRules, ps.mountPaths);
    }
  }
  if (pluginWarnings.length > 0) {
    for (const w of pluginWarnings) console.warn(`[F228] ${w}`);
  }
  if (config && configDirty) {
    await writeCapabilitiesConfig(projectRoot, config);
  }
}

/**
 * After a **default** mount-rules change, reconcile all registered projects
 * that inherit the default (i.e. have no project-level override).
 */
export async function reconcileInheritedProjectMountsAfterDefaultRuleChange(
  mainRoot: string,
  previousRules: MountRules,
  nextRules: MountRules,
  pluginsDir: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const reconcileInheritedProject = async (projectPath: string): Promise<void> => {
    try {
      if (await readProjectMountRulesOverride(projectPath)) return;
      await reconcileSkillMountsAfterRuleChange(projectPath, previousRules, nextRules, pluginsDir);
    } catch (err) {
      const msg = `Failed to reconcile inherited mount rules for ${projectPath}: ${(err as Error).message}`;
      console.warn(`[F228] ${msg}`);
      warnings.push(msg);
    }
  };

  await reconcileInheritedProject(mainRoot);

  const registry = new GovernanceRegistry(mainRoot);
  for (const entry of await registry.listAll()) {
    if (pathsEqual(entry.projectPath, mainRoot)) continue;
    await reconcileInheritedProject(entry.projectPath);
  }
  return warnings;
}
