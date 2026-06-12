/** Skill Sync Engine — F228: syncProject reconciles symlinks with config. */

import { lstat, mkdir, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { resolveEffectiveSkillMountPaths, validateSkillName } from '../config/governance/skill-sync.js';
import { pathsEqual } from '../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import { computeSourceManifestHash, listSourceSkillNames } from '../utils/skill-source.js';
import { readSkillsSyncState, updateConfigAfterSync, writeSkillsSyncState } from './skill-sync-config.js';

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

/** Classify a mount path: 'missing' | 'managed' | 'conflict'. */
export async function classifyMountPath(
  linkPath: string,
  skillsSource: string,
  skillName: string,
): Promise<'missing' | 'managed' | 'conflict'> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
  if (!stat.isSymbolicLink()) return 'conflict';

  const target = await readlink(linkPath);
  const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
  const expectedTarget = resolve(skillsSource, skillName);
  if (pathsEqual(absoluteTarget, expectedTarget)) return 'managed';

  const [realTarget, realExpected] = await Promise.all([
    realpath(absoluteTarget).catch(() => absoluteTarget),
    realpath(expectedTarget).catch(() => expectedTarget),
  ]);
  return pathsEqual(realTarget, realExpected) ? 'managed' : 'conflict';
}

async function convertDirectoryLevelMount(
  skillsDir: string,
  skillsSource: string,
  enabledSkillNames: string[],
): Promise<boolean> {
  try {
    if (!(await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource))) return false;
  } catch {
    return false;
  }
  await rm(skillsDir);
  await mkdir(skillsDir, { recursive: true });
  for (const skillName of enabledSkillNames) {
    const linkPath = join(skillsDir, skillName);
    await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
  }
  return true;
}

interface ProviderTarget {
  id: string;
  dirs: string[];
}

function activeProviderTargets(projectRoot: string, rules: MountRules): ProviderTarget[] {
  const standard = STANDARD_PROVIDER_IDS.filter((id) => rules.providers[id].enabled).map((id) => ({
    id,
    dirs: [join(projectRoot, rules.providers[id].path)],
  }));
  const custom = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .map((t) => ({ id: t.id, dirs: t.candidates }));
  return [...standard, ...custom];
}

function allProviderDirs(projectRoot: string, rules: MountRules): string[] {
  const standardDirs = STANDARD_PROVIDER_IDS.map((id) => join(projectRoot, rules.providers[id].path));
  const customDirs = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .flatMap((t) => t.candidates);
  return [...new Set([...standardDirs, ...customDirs])];
}

export interface MountConflict {
  skillName: string;
  providerId: string;
  path: string;
}

export interface SyncProjectResult {
  mounted: Array<{ skillName: string; providerId: string; path?: string }>;
  unmounted: Array<{ skillName: string; providerId: string; path?: string }>;
  conflicts: MountConflict[];
  removed: string[];
  syncedHash: string;
}

export interface SyncProjectOptions {
  mountRules: MountRules;
  previousMountRules?: MountRules;
  disabledSkills?: ReadonlySet<string>;
  cascadeDisabledSkills?: ReadonlySet<string>;
  mountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  force?: boolean;
  /** Prune ALL mountPaths to active providers (set on mount rules change). */
  pruneMountPaths?: boolean;
  /** Skills to treat as removed even if still in source tree.
   *  Used by drift resolver to clean config orphans (project-only skills
   *  not in global config). Merged into removedNames for config cleanup. */
  additionalRemovedSkills?: ReadonlySet<string>;
}

export async function syncProject(
  projectRoot: string,
  skillsSource: string,
  opts: SyncProjectOptions,
): Promise<SyncProjectResult> {
  const { mountRules, force = false } = opts;
  const sourceNames = await listSourceSkillNames(skillsSource);

  const existingConfig = await readCapabilitiesConfig(projectRoot);
  // Ensure capabilities.json exists so updateConfigAfterSync can update it
  if (!existingConfig) {
    await writeCapabilitiesConfig(projectRoot, { version: 2, capabilities: [] });
  }
  const config = existingConfig ?? { version: 2 as const, capabilities: [] as never[] };
  const managedCaps = config.capabilities.filter(
    (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId,
  );
  const previousNames = managedCaps.map((cap) => cap.id);
  const configDisabledSet = new Set(managedCaps.filter((cap) => !cap.enabled).map((cap) => cap.id));
  const configMountPaths = new Map(
    managedCaps.flatMap((cap) => (Array.isArray(cap.mountPaths) ? [[cap.id, [...cap.mountPaths]] as const] : [])),
  );

  const prevCascadeDisabled = new Set((await readSkillsSyncState(projectRoot))?.cascadeDisabledSkills ?? []);
  // When caller doesn't provide disabledSkills, fall back to config — but exclude
  // entries that were only there from a previous cascade (not user choice).
  // Without this exclusion, a globally re-enabled skill stays stuck disabled because
  // configDisabledSet includes the stale cascade entry.
  const disabledSet = new Set<string>(
    opts.disabledSkills ?? [...configDisabledSet].filter((s) => !prevCascadeDisabled.has(s)),
  );
  const cascadeDisabledInThisSync = new Set<string>();
  const projectConfiguredSkills = new Set(
    previousNames.filter((name) => !prevCascadeDisabled.has(name) || !configDisabledSet.has(name)),
  );
  for (const sn of opts.cascadeDisabledSkills ?? []) {
    if (!projectConfiguredSkills.has(sn)) {
      disabledSet.add(sn);
      cascadeDisabledInThisSync.add(sn);
    }
  }
  const mountPathsBySkill = new Map(configMountPaths);
  const explicitMountPathSkills = new Set(opts.mountPathsBySkill ? opts.mountPathsBySkill.keys() : []);
  if (opts.mountPathsBySkill) {
    for (const [k, v] of opts.mountPathsBySkill) mountPathsBySkill.set(k, [...v]);
  }
  for (const sn of prevCascadeDisabled) {
    if (!disabledSet.has(sn) && configDisabledSet.has(sn)) mountPathsBySkill.delete(sn);
  }
  const enabledNames = sourceNames.filter((n) => !disabledSet.has(n));
  const disabledNames = sourceNames.filter((n) => disabledSet.has(n));
  const sourceSet = new Set(sourceNames);
  const removedNames = [...previousNames.filter((n) => !sourceSet.has(n)), ...(opts.additionalRemovedSkills ?? [])];

  // Per-skill mount target resolution
  const activeTargets = activeProviderTargets(projectRoot, mountRules);
  const activeTargetIds = activeTargets.map((t) => t.id);
  const mountTargetIdsBySkill = new Map(
    enabledNames.map((skillName) => {
      const declared = resolveEffectiveSkillMountPaths(
        mountPathsBySkill.get(skillName),
        opts.globalMountPathsBySkill?.get(skillName),
      );
      const ids = declared ? activeTargetIds.filter((id) => new Set(declared).has(id)) : activeTargetIds;
      return [skillName, new Set(ids)] as const;
    }),
  );

  const result: SyncProjectResult = {
    mounted: [],
    unmounted: [],
    conflicts: [],
    removed: removedNames,
    syncedHash: '',
  };
  // Phase 1: Convert legacy directory-level mounts (always attempt — plugins need individual symlinks)
  for (const target of activeTargets) {
    const targetEnabled = enabledNames.filter((n) => mountTargetIdsBySkill.get(n)?.has(target.id));
    for (const dir of target.dirs) {
      const converted = await convertDirectoryLevelMount(dir, skillsSource, targetEnabled);
      if (converted) {
        // Disabled skills + enabled skills filtered by mount policy are implicitly unmounted
        for (const n of disabledNames) result.unmounted.push({ skillName: n, providerId: target.id });
        for (const n of enabledNames) {
          if (!mountTargetIdsBySkill.get(n)?.has(target.id)) {
            result.unmounted.push({ skillName: n, providerId: target.id });
          }
        }
      }
    }
  }

  // Phase 2: Mount enabled + remove out-of-policy
  for (const target of activeTargets) {
    const targetEnabled = enabledNames.filter((n) => mountTargetIdsBySkill.get(n)?.has(target.id));
    const outOfPolicy = enabledNames.filter((n) => !mountTargetIdsBySkill.get(n)?.has(target.id));

    for (const skillsDir of target.dirs) {
      let isLegacyManaged = false;
      try {
        isLegacyManaged = await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource);
      } catch {
        /* */
      }
      if (isLegacyManaged) continue;
      try {
        if ((await lstat(skillsDir)).isSymbolicLink()) {
          if (force) {
            await rm(skillsDir, { force: true });
          } else {
            for (const sn of targetEnabled)
              result.conflicts.push({ skillName: sn, providerId: target.id, path: skillsDir });
            continue;
          }
        }
      } catch {
        /* ENOENT — will be created below */
      }
      await mkdir(skillsDir, { recursive: true });

      for (const skillName of targetEnabled) {
        validateSkillName(skillName);
        const linkPath = join(skillsDir, skillName);
        const status = await classifyMountPath(linkPath, skillsSource, skillName);
        if (status === 'missing' || (status === 'conflict' && force)) {
          if (status === 'conflict') await rm(linkPath, { recursive: true, force: true });
          await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
          result.mounted.push({ skillName, providerId: target.id, path: linkPath });
        } else if (status === 'conflict') {
          result.conflicts.push({ skillName, providerId: target.id, path: linkPath });
        }
      }

      for (const skillName of outOfPolicy) {
        const linkPath = join(skillsDir, skillName);
        if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
          await rm(linkPath);
          result.unmounted.push({ skillName, providerId: target.id, path: linkPath });
        }
      }
    }
  }

  // Phase 3: Remove disabled/removed/orphan from ALL provider dirs
  const cleanupNames = new Set([...disabledNames, ...removedNames]);
  const activeDirSet = new Set(activeTargets.flatMap((t) => t.dirs));
  for (const skillsDir of allProviderDirs(projectRoot, mountRules)) {
    try {
      if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) continue;
    } catch {
      continue;
    }
    const isDisabledProvider = !activeDirSet.has(skillsDir);
    const entries = await readdir(skillsDir).catch(() => [] as string[]);
    const dirCleanup = new Set(cleanupNames);
    for (const entry of entries) {
      if (!isDisabledProvider && !dirCleanup.has(entry) && sourceSet.has(entry)) continue;
      dirCleanup.add(entry);
    }
    for (const skillName of dirCleanup) {
      const linkPath = join(skillsDir, skillName);
      if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
        await rm(linkPath);
        result.unmounted.push({ skillName, providerId: 'cleanup', path: linkPath });
      }
    }
  }

  // Phase 4: Clean up old provider paths from previous mount rules
  if (opts.previousMountRules) {
    const currentDirs = new Set(allProviderDirs(projectRoot, mountRules));
    for (const oldDir of allProviderDirs(projectRoot, opts.previousMountRules)) {
      if (currentDirs.has(oldDir)) continue;
      try {
        if (await isManagedDirectoryLevelSkillsSymlink(oldDir, skillsSource)) {
          await rm(oldDir);
          continue;
        }
      } catch {
        /* */
      }
      for (const entry of await readdir(oldDir).catch(() => [] as string[])) {
        const lp = join(oldDir, entry);
        if ((await classifyMountPath(lp, skillsSource, entry)) === 'managed') {
          await rm(lp);
          result.unmounted.push({ skillName: entry, providerId: 'old-provider', path: lp });
        }
      }
    }
  }

  // P1-1 fix: keep conflicting skills in enabledNames — partial conflict does NOT
  // disable the whole skill. Config preserves user intent (mountPaths unchanged);
  // conflicts are reported in SyncProjectResult for callers to surface.
  await updateConfigAfterSync(projectRoot, {
    enabledNames,
    disabledNames,
    removedNames,
    mountPathsBySkill,
    projectConfigMountPaths: configMountPaths,
    explicitMountPathSkills,
    activeTargetIds,
    cascadeDisabledInThisSync,
    prevCascadeDisabled,
    configDisabledSet,
    globalMountPathsBySkill: opts.globalMountPathsBySkill,
    mountRules,
    pruneMountPaths: opts.pruneMountPaths,
  });

  const newHash = await computeSourceManifestHash(skillsSource);
  result.syncedHash = newHash;
  await writeSkillsSyncState(projectRoot, {
    sourceRoot: relative(projectRoot, skillsSource),
    sourceManifestHash: newHash,
    lastSyncedAt: new Date().toISOString(),
    ...(cascadeDisabledInThisSync.size > 0 ? { cascadeDisabledSkills: [...cascadeDisabledInThisSync].sort() } : {}),
  });

  return result;
}
