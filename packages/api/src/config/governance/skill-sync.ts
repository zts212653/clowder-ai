/**
 * ADR-025 Phase 2: Skill Sync Service
 *
 * Creates/updates per-skill symlinks for the enabled providers (project-level)
 * and writes capabilities.json#skillsSync. F228: provider list is no longer hardcoded —
 * it derives from `MountRules` so disabled providers stay untouched and
 * future ACP/A2A clients can be added via configuration.
 */

import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { DEFAULT_MOUNT_RULES, type MountRules, STANDARD_PROVIDER_IDS, type StandardProviderId } from '@cat-cafe/shared';
import { pathsEqual } from '../../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../../utils/skill-mount.js';
import {
  discardSkillMountSnapshot,
  restoreSkillMountSnapshot,
  type SkillMountSnapshot,
  snapshotSkillMountsForProject,
} from '../../utils/skill-symlink-writer.js';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../capabilities/capability-orchestrator.js';
import {
  computeSourceManifestHash,
  listSourceSkillNames,
  readSkillsSyncState,
  removeCatCafeSkillCapabilities,
  updateSkillMountPaths,
  writeSkillsSyncState,
} from './skills-state.js';

function enabledStandardProviderIds(rules: MountRules): StandardProviderId[] {
  return STANDARD_PROVIDER_IDS.filter((id) => rules.providers[id].enabled);
}

function uniqueDirs(dirs: string[]): string[] {
  return [...new Set(dirs)];
}

function disabledStandardProjectProviderDirs(projectRoot: string, rules: MountRules): string[] {
  return STANDARD_PROVIDER_IDS.filter((id) => !rules.providers[id].enabled).map((id) =>
    join(projectRoot, rules.providers[id].path),
  );
}

function standardProjectProviderDirs(projectRoot: string, rules: MountRules): string[] {
  return STANDARD_PROVIDER_IDS.map((id) => join(projectRoot, rules.providers[id].path));
}

function customProjectProviderDirs(projectRoot: string, rules: MountRules): string[] {
  return buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((target) => target.kind === 'custom')
    .flatMap((target) => target.candidates);
}

interface ProjectProviderTarget {
  id: string;
  dirs: string[];
}

function activeProjectProviderTargets(projectRoot: string, rules: MountRules): ProjectProviderTarget[] {
  const standardTargets = enabledStandardProviderIds(rules).map((id) => ({
    id,
    dirs: [join(projectRoot, rules.providers[id].path)],
  }));
  const customTargets = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((target) => target.kind === 'custom')
    .map((target) => ({
      id: target.id,
      dirs: target.candidates,
    }));
  return [...standardTargets, ...customTargets];
}

function removableProjectProviderDirs(projectRoot: string, rules: MountRules): string[] {
  return uniqueDirs([
    ...standardProjectProviderDirs(projectRoot, rules),
    ...customProjectProviderDirs(projectRoot, rules),
  ]);
}

/** Safe skill name: lowercase letters, digits, hyphens. No path separators, dots-only, or absolute paths. */
const VALID_SKILL_NAME = /^[a-z][a-z0-9-]*$/;

export function validateSkillName(name: string): void {
  if (!VALID_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${VALID_SKILL_NAME}.`);
  }
}

export interface SkillsSyncResult {
  synced: string[];
  removed: string[];
  newHash: string;
}

export interface SkillsSyncOptions {
  disabledSkills?: Iterable<string>;
  globalDisabledSkills?: Iterable<string>;
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
}

export function resolveEffectiveSkillMountPaths(
  projectMountPaths?: readonly string[],
  globalMountPaths?: readonly string[],
): string[] | undefined {
  // F228: Project-local mountPaths is authoritative when present.
  // Global mountPaths is only used as fallback when local policy is absent.
  // (Previous implementation took intersection — that treated global as a
  // hard constraint. Now global is a cascade default only.)
  if (projectMountPaths) return [...projectMountPaths];
  if (globalMountPaths) return [...globalMountPaths];
  return undefined;
}

async function symlinkPointsTo(linkPath: string, target: string): Promise<boolean> {
  const existing = await readlink(linkPath);
  if (existing === target) return true;

  const absoluteExisting = isAbsolute(existing) ? existing : resolve(dirname(linkPath), existing);
  const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
  if (pathsEqual(absoluteExisting, absoluteTarget)) return true;

  const [realExisting, realTarget] = await Promise.all([
    realpath(absoluteExisting).catch(() => absoluteExisting),
    realpath(absoluteTarget).catch(() => absoluteTarget),
  ]);
  return pathsEqual(realExisting, realTarget);
}

function buildSyncMountConflictError(linkPath: string): Error {
  return new Error(
    `Refusing to sync skill mount at ${linkPath}: path already exists and is not a managed Cat Cafe skill symlink.`,
  );
}

interface ManagedSkillSyncPolicy {
  previousNames: string[];
  mountPathsBySkill: Map<string, string[]>;
  /** Skills that are currently disabled in project config (cap.enabled === false). */
  configDisabledSet: Set<string>;
}

async function readManagedSkillPolicyForSync(projectRoot: string): Promise<ManagedSkillSyncPolicy> {
  const config = await readCapabilitiesConfig(projectRoot);
  const managedCaps =
    config?.capabilities.filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId) ?? [];
  return {
    previousNames: managedCaps.map((cap) => cap.id),
    mountPathsBySkill: new Map(
      managedCaps.flatMap((cap) => (Array.isArray(cap.mountPaths) ? [[cap.id, [...cap.mountPaths]]] : [])),
    ),
    configDisabledSet: new Set(managedCaps.filter((cap) => !cap.enabled).map((cap) => cap.id)),
  };
}

export async function ensureCorrectSymlink(linkPath: string, target: string): Promise<void> {
  try {
    const s = await lstat(linkPath);
    if (s.isSymbolicLink()) {
      if (await symlinkPointsTo(linkPath, target)) return;
      throw buildSyncMountConflictError(linkPath);
    }
    throw buildSyncMountConflictError(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await symlink(target, linkPath);
}

export async function removeSymlinkIfExists(linkPath: string): Promise<void> {
  let s: Awaited<ReturnType<typeof lstat>>;
  try {
    s = await lstat(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (s.isSymbolicLink()) await rm(linkPath);
}

async function removeManagedSymlinkIfExists(linkPath: string, sourcePath: string): Promise<void> {
  let s: Awaited<ReturnType<typeof lstat>>;
  try {
    s = await lstat(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!s.isSymbolicLink()) return;

  const target = await readlink(linkPath);
  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
  if (pathsEqual(resolvedTarget, resolve(sourcePath))) await rm(linkPath);
}

async function pathIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

async function convertDirectoryLevelMountToPerSkillLinks(
  skillsDir: string,
  skillsSource: string,
  skillNames: string[],
): Promise<boolean> {
  if (!(await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource))) return false;

  await rm(skillsDir);
  await mkdir(skillsDir, { recursive: true });
  for (const skillName of skillNames) {
    const linkPath = join(skillsDir, skillName);
    await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
  }
  return true;
}

async function findDeferredRemovedSkills(
  projectRoot: string,
  rules: MountRules,
  removed: string[],
): Promise<Set<string>> {
  const deferredRemoved = new Set<string>();
  for (const providerDir of disabledStandardProjectProviderDirs(projectRoot, rules)) {
    for (const skillName of removed) {
      if (await pathIsSymlink(join(providerDir, skillName))) {
        deferredRemoved.add(skillName);
      }
    }
  }
  return deferredRemoved;
}

async function snapshotSyncSkillMounts(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  skillNames: string[],
): Promise<SkillMountSnapshot> {
  const entries: SkillMountSnapshot['entries'] = [];
  const seen = new Set<string>();
  try {
    for (const skillName of skillNames) {
      const snapshot = await snapshotSkillMountsForProject(projectRoot, skillName, skillsSource, rules, {
        includeManagedDirectoryRoots: true,
        preserveNonSymlinks: true,
      });
      for (const entry of snapshot.entries) {
        if (seen.has(entry.linkPath)) continue;
        seen.add(entry.linkPath);
        entries.push(entry);
      }
    }
    return { entries };
  } catch (err) {
    await restoreSkillMountSnapshot({ entries }).catch(() => {});
    throw err;
  }
}

async function restoreCapabilitiesConfigSnapshot(
  projectRoot: string,
  snapshot: Awaited<ReturnType<typeof readCapabilitiesConfig>>,
): Promise<void> {
  if (snapshot) {
    await writeCapabilitiesConfig(projectRoot, snapshot);
    return;
  }
  await rm(join(projectRoot, '.cat-cafe', 'capabilities.json'), { force: true });
}

async function convertActiveDirectoryLevelMounts(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  currentNames: string[],
  disabledCurrentNames: string[],
  mountTargetIdsBySkill: Map<string, Set<string>>,
): Promise<void> {
  for (const target of activeProjectProviderTargets(projectRoot, rules)) {
    const targetCurrentNames = currentNames.filter((skillName) => mountTargetIdsBySkill.get(skillName)?.has(target.id));
    if (disabledCurrentNames.length === 0 && targetCurrentNames.length === currentNames.length) continue;
    for (const providerDir of target.dirs) {
      await convertDirectoryLevelMountToPerSkillLinks(providerDir, skillsSource, targetCurrentNames);
    }
  }
}

async function syncProjectProviderDir(
  skillsDir: string,
  skillsSource: string,
  currentNames: string[],
  removed: string[],
): Promise<void> {
  if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
    // Legacy directory-level mounts are already valid. Do not follow the
    // symlink and write per-skill links back into the source skills tree.
    return;
  }
  await mkdir(skillsDir, { recursive: true });

  for (const skillName of currentNames) {
    const linkPath = join(skillsDir, skillName);
    const target = symlinkTargetFor(linkPath, join(skillsSource, skillName));
    await ensureCorrectSymlink(linkPath, target);
  }

  for (const skillName of removed) {
    await removeManagedSymlinkIfExists(join(skillsDir, skillName), join(skillsSource, skillName));
  }
}

async function syncActiveProjectProviderDirs(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  currentNames: string[],
  removed: string[],
  mountTargetIdsBySkill: Map<string, Set<string>>,
): Promise<void> {
  for (const target of activeProjectProviderTargets(projectRoot, rules)) {
    const targetCurrentNames = currentNames.filter((skillName) => mountTargetIdsBySkill.get(skillName)?.has(target.id));
    const outOfPolicyNames = currentNames.filter((skillName) => !mountTargetIdsBySkill.get(skillName)?.has(target.id));
    const targetRemoved = [...new Set([...removed, ...outOfPolicyNames])];
    for (const skillsDir of target.dirs) {
      await syncProjectProviderDir(skillsDir, skillsSource, targetCurrentNames, targetRemoved);
    }
  }
}

async function removeDisabledCurrentSkillLinks(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  disabledCurrentNames: string[],
): Promise<void> {
  for (const providerDir of removableProjectProviderDirs(projectRoot, rules)) {
    for (const skillName of disabledCurrentNames) {
      await removeManagedSymlinkIfExists(join(providerDir, skillName), join(skillsSource, skillName));
    }
  }
}

/**
 * Sync per-skill symlinks for every enabled standard provider and every custom
 * path in `rules`, then update capabilities.json#skillsSync. F228: when `rules` is omitted,
 * defaults to all 4 standard providers enabled — fully backward-compatible with
 * pre-F228 callers.
 *
 * - Creates symlinks: `{projectRoot}/{providerPath}/{skillName}` → `{skillsSource}/{skillName}`
 * - Removes stale symlinks for skills no longer in source
 * - Updates `.cat-cafe/capabilities.json#skillsSync`
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: F228 project-local policy gate adds branches that are linear, not nested
export async function syncSkills(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules = DEFAULT_MOUNT_RULES,
  opts: SkillsSyncOptions = {},
): Promise<SkillsSyncResult> {
  const sourceNames = await listSourceSkillNames(skillsSource);
  // Read project policy first — needed to determine which globally-disabled
  // skills should cascade vs. which have an explicit project-local override.
  const {
    previousNames,
    mountPathsBySkill,
    configDisabledSet: prevConfigDisabledSet,
  } = await readManagedSkillPolicyForSync(projectRoot);

  // F228: Read previous cascade state to distinguish cascade-disabled entries
  // (written by a previous sync's global cascade) from user-explicit project policy.
  const prevSyncState = await readSkillsSyncState(projectRoot);
  const prevCascadeDisabled = new Set(prevSyncState?.cascadeDisabledSkills ?? []);

  // F228: Build disabled set. Project-local disabled skills are always honored.
  const disabledSet = new Set<string>();
  for (const skillName of opts.disabledSkills ?? []) disabledSet.add(skillName);

  // F228: Project-configured skills = previous names MINUS skills whose config entry
  // was written by a previous cascade (not user action). A cascade-disabled entry that
  // the user has since re-enabled (cap.enabled = true) IS treated as user-configured.
  const projectConfiguredSkills = new Set(
    previousNames.filter((name) => {
      if (!prevCascadeDisabled.has(name)) return true;
      // Was cascade-disabled — only count as user-configured if user changed the state
      return !prevConfigDisabledSet.has(name);
    }),
  );

  // F228: Global disabled skills cascade as default — only apply when the
  // project has no local policy for the skill. Cascade origin is tracked in
  // syncState.cascadeDisabledSkills so a subsequent global re-enable can
  // correctly clear the stale project-config entry.
  const cascadeDisabledInThisSync = new Set<string>();
  for (const skillName of opts.globalDisabledSkills ?? []) {
    if (!projectConfiguredSkills.has(skillName)) {
      disabledSet.add(skillName);
      cascadeDisabledInThisSync.add(skillName);
    }
  }

  // F228: Clean stale cascade entries from mountPathsBySkill. When a skill was
  // cascade-disabled in a previous sync and is now re-enabled (not in disabledSet),
  // its config still has mountPaths:[] — delete from the map so
  // resolveEffectiveSkillMountPaths falls through to global policy or defaults.
  for (const skillName of prevCascadeDisabled) {
    if (!disabledSet.has(skillName) && prevConfigDisabledSet.has(skillName)) {
      mountPathsBySkill.delete(skillName);
    }
  }

  const currentNames = sourceNames.filter((name) => !disabledSet.has(name));
  const disabledCurrentNames = sourceNames.filter((name) => disabledSet.has(name));
  const activeTargetIds = activeProjectProviderTargets(projectRoot, rules).map((target) => target.id);
  const mountTargetIdsBySkill = new Map(
    currentNames.map((skillName) => {
      const declaredMountPaths = resolveEffectiveSkillMountPaths(
        mountPathsBySkill.get(skillName),
        opts.globalMountPathsBySkill?.get(skillName),
      );
      const declaredSet = declaredMountPaths ? new Set(declaredMountPaths) : null;
      const targetIds = declaredSet ? activeTargetIds.filter((targetId) => declaredSet.has(targetId)) : activeTargetIds;
      return [skillName, new Set(targetIds)] as const;
    }),
  );

  // Determine stale skills (in previous state but no longer in source)
  const sourceSet = new Set(sourceNames);
  const removed = previousNames.filter((n) => !sourceSet.has(n));
  const deferredRemoved = await findDeferredRemovedSkills(projectRoot, rules, removed);
  const syncMountSnapshot = await snapshotSyncSkillMounts(projectRoot, skillsSource, rules, [
    ...new Set([...currentNames, ...disabledCurrentNames, ...removed]),
  ]);
  const capabilitiesConfigSnapshot = await readCapabilitiesConfig(projectRoot);

  try {
    await convertActiveDirectoryLevelMounts(
      projectRoot,
      skillsSource,
      rules,
      currentNames,
      disabledCurrentNames,
      mountTargetIdsBySkill,
    );
    await syncActiveProjectProviderDirs(projectRoot, skillsSource, rules, currentNames, removed, mountTargetIdsBySkill);
    await removeDisabledCurrentSkillLinks(projectRoot, skillsSource, rules, disabledCurrentNames);

    // Update capabilities.json#skillsSync (v2)
    const newHash = await computeSourceManifestHash(skillsSource);
    const sourceRoot = relative(projectRoot, skillsSource);
    await writeSkillsSyncState(projectRoot, {
      sourceRoot,
      sourceManifestHash: newHash,
      lastSyncedAt: new Date().toISOString(),
      ...(cascadeDisabledInThisSync.size > 0 ? { cascadeDisabledSkills: [...cascadeDisabledInThisSync].sort() } : {}),
    });

    // Update mountPaths for synced/removed skills (standard + custom).
    // F228: persist DECLARED/DESIRED providers, not the active intersection.
    // mountTargetIdsBySkill (active intersection) drives symlink creation above.
    // capabilities.json stores the desired policy so that temporarily unavailable
    // providers (disabled in mount rules) can be restored without user intervention.
    if (currentNames.length > 0) {
      const groupedDeclared = new Map<string, { skillNames: string[]; providerNames: string[] }>();
      const noPolicySkills: string[] = [];
      for (const skillName of currentNames) {
        const declaredMountPaths = resolveEffectiveSkillMountPaths(
          mountPathsBySkill.get(skillName),
          opts.globalMountPathsBySkill?.get(skillName),
        );
        if (declaredMountPaths) {
          const key = JSON.stringify(declaredMountPaths);
          const group = groupedDeclared.get(key) ?? { skillNames: [], providerNames: [...declaredMountPaths] };
          group.skillNames.push(skillName);
          groupedDeclared.set(key, group);
        } else {
          noPolicySkills.push(skillName);
        }
      }
      for (const { skillNames, providerNames } of groupedDeclared.values()) {
        await updateSkillMountPaths(projectRoot, skillNames, providerNames);
      }
      // F228: Skills with no declared policy get mounted to all available mount points.
      // mountPaths = target mount policy, never undefined.
      // Cascade-re-enabled skills additionally need forceEnabled to clear stale
      // enabled:false from a previous global cascade disable.
      if (noPolicySkills.length > 0) {
        const cascadeReEnabledSet = new Set(
          noPolicySkills.filter(
            (name) => prevCascadeDisabled.has(name) && prevConfigDisabledSet.has(name) && !disabledSet.has(name),
          ),
        );
        if (cascadeReEnabledSet.size > 0) {
          await updateSkillMountPaths(projectRoot, [...cascadeReEnabledSet], activeTargetIds, { forceEnabled: true });
        }
        const genuineNoPolicySkills = noPolicySkills.filter((name) => !cascadeReEnabledSet.has(name));
        if (genuineNoPolicySkills.length > 0) {
          await updateSkillMountPaths(projectRoot, genuineNoPolicySkills, activeTargetIds);
        }
      }
    }
    if (removed.length > 0) {
      const deferredRemovedNames = removed.filter((skillName) => deferredRemoved.has(skillName));
      const fullyRemovedNames = removed.filter((skillName) => !deferredRemoved.has(skillName));
      await updateSkillMountPaths(projectRoot, deferredRemovedNames, [], { forceDisabled: true });
      await removeCatCafeSkillCapabilities(projectRoot, fullyRemovedNames);
    }

    // Persist disabled source skills as intentional project policy. This includes
    // globally disabled skills that were never present in the project config, so
    // staleness checks converge instead of reporting them as new/missing forever.
    if (disabledCurrentNames.length > 0) {
      await updateSkillMountPaths(projectRoot, disabledCurrentNames, [], { forceDisabled: true });
    }

    await discardSkillMountSnapshot(syncMountSnapshot);
    return {
      synced: currentNames,
      removed,
      newHash,
    };
  } catch (err) {
    await restoreSkillMountSnapshot(syncMountSnapshot).catch(() => {});
    await restoreCapabilitiesConfigSnapshot(projectRoot, capabilitiesConfigSnapshot).catch(() => {});
    throw err;
  }
}

/**
 * Resolve a single skill conflict between user-level and project-level.
 *
 * - 'official' → remove user-level symlinks (project/official version wins)
 * - 'mine' → remove project-level symlinks + remove from managed set (user version wins)
 */
export async function resolveConflict(
  projectRoot: string,
  homeDir: string,
  skillName: string,
  choice: 'official' | 'mine',
  rules: MountRules = DEFAULT_MOUNT_RULES,
): Promise<void> {
  validateSkillName(skillName);

  if (choice !== 'official' && choice !== 'mine') {
    throw new Error(`Invalid choice: ${choice}. Must be 'official' or 'mine'.`);
  }

  for (const providerId of enabledStandardProviderIds(rules)) {
    const projectProviderDir = rules.providers[providerId].path;
    const homeProviderDir = DEFAULT_MOUNT_RULES.providers[providerId].path;
    if (choice === 'official') {
      // Remove user-level symlink — project (official) version wins
      await removeSymlinkIfExists(join(homeDir, homeProviderDir, skillName));
    } else {
      // Remove project-level symlink — user version wins
      await removeSymlinkIfExists(join(projectRoot, projectProviderDir, skillName));
    }
  }

  // If 'mine': remove skill from the managed set.
  if (choice === 'mine') {
    const config = await readCapabilitiesConfig(projectRoot);
    if (!config) return;
    const cap = config.capabilities.find((c) => c.type === 'skill' && c.id === skillName);
    if (cap && cap.source === 'cat-cafe') {
      cap.source = 'external';
      await writeCapabilitiesConfig(projectRoot, config);
    }
  }
}
