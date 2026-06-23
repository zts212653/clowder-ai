/** Skill Sync Engine — F228: syncProject reconciles symlinks with config. */

import { lstat, mkdir, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import {
  isValidSkillName,
  resolveEffectiveSkillMountPaths,
  validateSkillName,
} from '../config/governance/skill-sync.js';
import { pathsEqual } from '../utils/project-path.js';
import {
  buildSkillMountTargets,
  createSkillSymlink,
  isManagedDirectoryLevelSkillsSymlink,
} from '../utils/skill-mount.js';
import { computeSourceManifestHash, listSourceSkillNames } from '../utils/skill-source.js';
import { updateConfigAfterSync, writeSkillsSyncState } from './skill-sync-config.js';

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
    await createSkillSymlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
  }
  return true;
}

interface MountTarget {
  id: string;
  dirs: string[];
}

function activeMountTargets(projectRoot: string, rules: MountRules): MountTarget[] {
  const standard = STANDARD_MOUNT_POINT_IDS.filter((id) => rules.mountPoints[id].enabled).map((id) => ({
    id,
    dirs: [join(projectRoot, rules.mountPoints[id].path)],
  }));
  const custom = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .map((t) => ({ id: t.id, dirs: t.candidates }));
  return [...standard, ...custom];
}

function allMountDirs(projectRoot: string, rules: MountRules): string[] {
  const standardDirs = STANDARD_MOUNT_POINT_IDS.map((id) => join(projectRoot, rules.mountPoints[id].path));
  const customDirs = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .flatMap((t) => t.candidates);
  return [...new Set([...standardDirs, ...customDirs])];
}

export interface MountConflict {
  skillName: string;
  mountPointId: string;
  path: string;
}

export interface SyncProjectResult {
  mounted: Array<{ skillName: string; mountPointId: string; path?: string }>;
  unmounted: Array<{ skillName: string; mountPointId: string; path?: string }>;
  conflicts: MountConflict[];
  removed: string[];
  syncedHash: string;
}

export interface SyncProjectOptions {
  mountRules: MountRules;
  previousMountRules?: MountRules;
  /** Authoritative disabled set. When provided, replaces config-derived disabled
   *  state entirely (used by syncAll for unconditional global cascade per F228
   *  scenarios 6/7). When omitted, disabled state is read from project config. */
  disabledSkills?: ReadonlySet<string>;
  mountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  force?: boolean;
  /** Prune ALL mountPaths to active mount points (set on mount rules change). */
  pruneMountPaths?: boolean;
  /** Skills to treat as removed even if still in source tree.
   *  Used by drift resolver to clean config orphans (project-only skills
   *  not in global config). Merged into removedNames for config cleanup. */
  additionalRemovedSkills?: ReadonlySet<string>;
  /** When true, inherited-only global mount paths are NOT written to project
   *  config — preserving dynamic cascade. Used by drift-resolver where global
   *  policy changes should propagate without freezing. Default false (explicit
   *  sync writes mount paths to establish local baseline). */
  preserveGlobalCascade?: boolean;
}

export async function syncProject(
  projectRoot: string,
  skillsSource: string,
  opts: SyncProjectOptions,
): Promise<SyncProjectResult> {
  return withCapabilityLock(projectRoot, () => syncProjectUnlocked(projectRoot, skillsSource, opts));
}

async function syncProjectUnlocked(
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
    (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && isValidSkillName(cap.id),
  );
  const previousNames = managedCaps.map((cap) => cap.id);
  // F228: project state is mountPaths-first. An explicit empty mountPaths means
  // locally disabled; non-empty mountPaths means locally enabled, even if legacy
  // enabled/globalEnabled is stale. Without mountPaths, fall back to global state.
  const configDisabledSet = new Set(
    managedCaps
      .filter((cap) =>
        Array.isArray(cap.mountPaths) ? cap.mountPaths.length === 0 : !(cap.globalEnabled ?? cap.enabled),
      )
      .map((cap) => cap.id),
  );
  const configMountPaths = new Map(
    managedCaps.flatMap((cap) => (Array.isArray(cap.mountPaths) ? [[cap.id, [...cap.mountPaths]] as const] : [])),
  );

  // F228 KD-6: disabledSkills is authoritative for ALL callers when provided —
  // global toggle (scenarios 6/7), mount-rule reconciliation (scenarios 9/11),
  // and plain reconciliation (POST /api/skills/sync, /api/skills/sync-skill,
  // PUT /api/mount-rules). Path A simplification (operator/mindfn 2026-06-17 IM sync):
  // unconditional cascade across caller types; project-local `mountPaths:[]` disable
  // is NOT preserved across global ops. See docs/features/F228 KD-6 + AC-C5 +
  // regression test 'POST /api/skills/sync clears project-local mountPaths:[]'
  // in test/skills-route.test.js.
  // When omitted (project-scope toggle), fall back to config-derived disabled state.
  const disabledSet = new Set<string>(opts.disabledSkills ?? configDisabledSet);
  const mountPathsBySkill = new Map(configMountPaths);
  const explicitMountPathSkills = new Set(opts.mountPathsBySkill ? opts.mountPathsBySkill.keys() : []);
  if (opts.mountPathsBySkill) {
    for (const [k, v] of opts.mountPathsBySkill) mountPathsBySkill.set(k, [...v]);
  }
  const enabledNames = sourceNames.filter((n) => !disabledSet.has(n));
  const disabledNames = sourceNames.filter((n) => disabledSet.has(n));

  // F228 KD-6: When disabledSkills is authoritative (ANY cascading caller — global
  // toggle, mount-rule reconciliation, OR plain reconciliation), and a skill is enabled
  // (not in disabledSet), clear config-derived empty mountPaths so the skill falls
  // through to the "no policy" path and gets all active mount points.
  // This is the **unconditional cascade** behavior chosen in Path A: project-local
  // `mountPaths:[]` disable does not survive any global op, including plain
  // POST /api/skills/sync (the over-preservation Path C trade-off Clowder AI explicitly
  // rejected). Without this, a previously cascade-disabled skill would stay disabled
  // even after the global source re-enables it.
  if (opts.disabledSkills) {
    for (const name of enabledNames) {
      if (!explicitMountPathSkills.has(name)) {
        const mps = mountPathsBySkill.get(name);
        if (mps && mps.length === 0) mountPathsBySkill.delete(name);
      }
    }
  }
  const sourceSet = new Set(sourceNames);
  const removedNames = [
    ...previousNames.filter((n) => !sourceSet.has(n)),
    ...[...(opts.additionalRemovedSkills ?? [])].filter(isValidSkillName),
  ];

  // Per-skill mount target resolution
  const activeTargets = activeMountTargets(projectRoot, mountRules);
  const activeTargetIds = activeTargets.map((t) => t.id);
  // F228: detect mount points that went from disabled → enabled (scenario 9).
  // Only supplement mount points that were previously KNOWN (in old rules but
  // inactive). Entirely new mount points (e.g., newly configured custom paths)
  // should not auto-cascade — those are new infrastructure, not a re-enable.
  const previousActiveIds = opts.previousMountRules
    ? new Set(activeMountTargets(projectRoot, opts.previousMountRules).map((t) => t.id))
    : undefined;
  const previousKnownIds = opts.previousMountRules
    ? new Set([...STANDARD_MOUNT_POINT_IDS, ...(opts.previousMountRules.customPaths ?? []).map((cp) => cp.alias)])
    : undefined;
  const newlyEnabledMountPointIds =
    previousActiveIds && previousKnownIds
      ? activeTargetIds.filter((id) => !previousActiveIds.has(id) && previousKnownIds.has(id))
      : undefined;
  const mountTargetIdsBySkill = new Map(
    enabledNames.map((skillName) => {
      const declared = resolveEffectiveSkillMountPaths(
        mountPathsBySkill.get(skillName),
        opts.globalMountPathsBySkill?.get(skillName),
      );
      const declaredSet = declared ? new Set(declared) : undefined;
      const ids = declaredSet ? activeTargetIds.filter((id) => declaredSet.has(id)) : [...activeTargetIds];
      // F228 scenario 9: when a mount point is newly enabled, supplement it into
      // the desired mount set for active skills (non-empty declared mountPaths).
      // This ensures both filesystem symlinks AND config are updated together.
      if (newlyEnabledMountPointIds?.length && declaredSet && ids.length > 0) {
        for (const id of newlyEnabledMountPointIds) {
          if (!ids.includes(id)) ids.push(id);
        }
      }
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
        for (const n of disabledNames) result.unmounted.push({ skillName: n, mountPointId: target.id });
        for (const n of enabledNames) {
          if (!mountTargetIdsBySkill.get(n)?.has(target.id)) {
            result.unmounted.push({ skillName: n, mountPointId: target.id });
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
              result.conflicts.push({ skillName: sn, mountPointId: target.id, path: skillsDir });
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
          await createSkillSymlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
          result.mounted.push({ skillName, mountPointId: target.id, path: linkPath });
        } else if (status === 'conflict') {
          result.conflicts.push({ skillName, mountPointId: target.id, path: linkPath });
        }
      }

      for (const skillName of outOfPolicy) {
        const linkPath = join(skillsDir, skillName);
        if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
          await rm(linkPath);
          result.unmounted.push({ skillName, mountPointId: target.id, path: linkPath });
        }
      }
    }
  }

  // Phase 3: Remove disabled/removed/orphan from ALL mount point dirs
  const cleanupNames = new Set([...disabledNames, ...removedNames]);
  const activeDirSet = new Set(activeTargets.flatMap((t) => t.dirs));
  for (const skillsDir of allMountDirs(projectRoot, mountRules)) {
    try {
      if (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource)) {
        // R1 P2: disabled mount point's directory-level symlink must be removed.
        // Phase 1 only converts active mount points, so disabled ones are never
        // cleaned up and keep exposing all skills through the legacy root.
        if (!activeDirSet.has(skillsDir)) {
          await rm(skillsDir);
          result.unmounted.push({ skillName: '*', mountPointId: 'cleanup', path: skillsDir });
        }
        continue;
      }
    } catch {
      continue;
    }
    const isDisabledMount = !activeDirSet.has(skillsDir);
    const entries = await readdir(skillsDir).catch(() => [] as string[]);
    const dirCleanup = new Set(cleanupNames);
    for (const entry of entries) {
      if (!isDisabledMount && !dirCleanup.has(entry) && sourceSet.has(entry)) continue;
      dirCleanup.add(entry);
    }
    for (const skillName of dirCleanup) {
      const linkPath = join(skillsDir, skillName);
      if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
        await rm(linkPath);
        result.unmounted.push({ skillName, mountPointId: 'cleanup', path: linkPath });
      }
    }
  }

  // Phase 4: Clean up old mount paths from previous mount rules
  if (opts.previousMountRules) {
    const currentDirs = new Set(allMountDirs(projectRoot, mountRules));
    for (const oldDir of allMountDirs(projectRoot, opts.previousMountRules)) {
      if (currentDirs.has(oldDir)) continue;
      try {
        if (await isManagedDirectoryLevelSkillsSymlink(oldDir, skillsSource)) {
          await rm(oldDir);
          continue;
        }
      } catch {
        /* */
      }
      // Guard: if oldDir is a symlink to a non-matching source, skip readdir
      // to avoid following the symlink and deleting content from the target.
      try {
        if ((await lstat(oldDir)).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      for (const entry of await readdir(oldDir).catch(() => [] as string[])) {
        const lp = join(oldDir, entry);
        if ((await classifyMountPath(lp, skillsSource, entry)) === 'managed') {
          await rm(lp);
          result.unmounted.push({ skillName: entry, mountPointId: 'old-mount', path: lp });
        }
      }
    }
  }

  // P1-1 fix: keep conflicting skills in enabledNames — partial conflict does NOT
  // disable the whole skill. Config preserves user intent (mountPaths unchanged);
  // conflicts are reported in SyncProjectResult for callers to surface.
  try {
    await updateConfigAfterSync(projectRoot, {
      enabledNames,
      disabledNames,
      removedNames,
      mountPathsBySkill,
      projectConfigMountPaths: configMountPaths,
      explicitMountPathSkills,
      activeTargetIds,
      globalMountPathsBySkill: opts.globalMountPathsBySkill,
      mountRules,
      pruneMountPaths: opts.pruneMountPaths,
      preserveGlobalCascade: opts.preserveGlobalCascade,
      existingProjectSkills: new Set(previousNames),
      newlyEnabledMountPointIds: opts.pruneMountPaths ? newlyEnabledMountPointIds : undefined,
    });

    const newHash = await computeSourceManifestHash(skillsSource);
    result.syncedHash = newHash;
    await writeSkillsSyncState(projectRoot, {
      sourceRoot: relative(projectRoot, skillsSource),
      sourceManifestHash: newHash,
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (configWriteErr) {
    // Rollback filesystem mutations so symlinks stay consistent with config.
    // Only entries with a path had actual filesystem operations.
    for (const op of result.mounted) {
      if (op.path) await rm(op.path, { force: true }).catch(() => {});
    }
    for (const op of result.unmounted) {
      if (!op.path || op.skillName === '*') continue; // No path or directory-level rollback not feasible
      const target = join(skillsSource, op.skillName);
      await createSkillSymlink(symlinkTargetFor(op.path, target), op.path).catch(() => {});
    }
    throw configWriteErr;
  }

  return result;
}
