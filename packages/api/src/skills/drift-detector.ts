/**
 * Drift Detector — F228 Three-Layer Model
 *
 * Three data layers, each compared only to its adjacent:
 *
 *   cat-cafe-skills/ source
 *           ↕ checkGlobal (registration: source ↔ global config)
 *   Global capabilities.json
 *           ↕ checkProject (config sync: global ↔ project config)
 *   Project capabilities.json (mountPaths) ↔ mount point symlinks
 *
 * Entry points:
 *   - checkGlobal: source ↔ global config + global mount sync ("全部 Skill" tab)
 *   - checkProject: global ↔ project config + project mount sync ("项目 Skill" tab)
 *   - detectDrift: mount-only compat wrapper (drift-resolver + tests)
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { readProjectState } from '../config/mount/project-state-store.js';
import { pathsEqual } from '../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import {
  canonicalSkillMountPathPolicy,
  normalizeSkillMountPathPolicy,
  type SkillMountPathInput,
  skillAllowsMountProvider,
} from '../utils/skill-mount-policy.js';
import { listSourceSkillNames } from '../utils/skill-source.js';

// ────────── Exported types ──────────

export interface DriftConflict {
  skill: string;
  kind: 'other-symlink' | 'directory' | 'file';
  provider: string;
  pointsTo?: string;
}

export interface DriftResult {
  newSkills: string[];
  conflicts: DriftConflict[];
  stale: string[];
  driftHash: string;
  isIgnored: boolean;
}

export interface CheckGlobalOpts {
  /** Skills registered in global capabilities.json (cat-cafe managed). */
  globalConfigSkills: ReadonlySet<string>;
  disabledSkills: Iterable<string>;
  skillMountPaths: SkillMountPathInput;
  platformName?: NodeJS.Platform;
}

export interface CheckProjectOpts {
  /** Skills registered in global capabilities.json. */
  globalConfigSkills: ReadonlySet<string>;
  /** Skills registered in this project's capabilities.json. */
  projectConfigSkills: ReadonlySet<string>;
  /** Merged disabled skills (global + project). */
  disabledSkills: Iterable<string>;
  /** Merged skill mount path policy (global + project). */
  skillMountPaths: SkillMountPathInput;
  platformName?: NodeJS.Platform;
}

// ────────── Internal types ──────────

type ClassifiedEntry =
  | { kind: 'managed-symlink' }
  | { kind: 'other-symlink'; pointsTo: string }
  | { kind: 'directory' }
  | { kind: 'file' }
  | { kind: 'missing' };

interface DriftMountTarget {
  key: string;
  provider: string;
  dir: string;
}

interface MountDriftResult {
  missingMounts: string[];
  conflicts: DriftConflict[];
  staleMounts: Set<string>;
}

// ────────── Helpers ──────────

function resolveSymlinkTarget(linkPath: string, target: string): string {
  return isAbsolute(target) ? target : resolve(dirname(linkPath), target);
}

async function canonicalizePath(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function describeDirectorySymlinkTarget(skillsDir: string): Promise<string | undefined> {
  try {
    const stat = await lstat(skillsDir);
    if (!stat.isSymbolicLink()) return undefined;
    const target = await readlink(skillsDir);
    return resolveSymlinkTarget(skillsDir, target);
  } catch {
    return undefined;
  }
}

async function classifyEntry(
  entryPath: string,
  expectedTarget: string,
  platformName: NodeJS.Platform = process.platform,
): Promise<ClassifiedEntry> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(entryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'file' };
    return { kind: 'missing' };
  }
  if (stat.isSymbolicLink()) {
    let target = '';
    try {
      target = await readlink(entryPath);
    } catch {
      return { kind: 'other-symlink', pointsTo: 'unreadable' };
    }
    const resolvedTarget = resolveSymlinkTarget(entryPath, target);
    const [canonicalTarget, canonicalExpected] = await Promise.all([
      canonicalizePath(resolvedTarget),
      canonicalizePath(resolve(expectedTarget)),
    ]);
    if (pathsEqual(canonicalTarget, canonicalExpected, platformName)) return { kind: 'managed-symlink' };
    return { kind: 'other-symlink', pointsTo: resolvedTarget };
  }
  if (stat.isDirectory()) return { kind: 'directory' };
  return { kind: 'file' };
}

function canonicalMountPolicy(mountRules: MountRules): object {
  return {
    version: mountRules.version,
    providers: Object.fromEntries(
      STANDARD_PROVIDER_IDS.map((id) => {
        const rule = mountRules.providers[id];
        return [id, { enabled: rule.enabled, path: rule.enabled ? rule.path : '' }];
      }),
    ),
    customPaths: [...mountRules.customPaths]
      .map((entry) => ({ alias: entry.alias, path: entry.path }))
      .sort((a, b) => a.alias.localeCompare(b.alias) || a.path.localeCompare(b.path)),
  };
}

function buildDriftMountTargets(projectRoot: string, mountRules: MountRules): DriftMountTarget[] {
  const standardTargets = STANDARD_PROVIDER_IDS.flatMap((id) => {
    const rule = mountRules.providers[id];
    if (!rule.enabled) return [];
    const dir = join(projectRoot, rule.path);
    return [{ key: `standard:${id}:${dir}`, provider: id, dir }];
  });
  const customTargets = buildSkillMountTargets(projectRoot, homedir(), mountRules)
    .filter((target) => target.kind === 'custom')
    .flatMap((target) =>
      target.candidates.map((dir) => ({
        key: `custom:${target.id}:${dir}`,
        provider: target.id,
        dir,
      })),
    );
  return [...standardTargets, ...customTargets];
}

function computeDriftHash(
  expectedNames: readonly string[],
  disabledNames: readonly string[],
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  mountRules: MountRules,
  details: Pick<DriftResult, 'newSkills' | 'conflicts' | 'stale'>,
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      expected: [...expectedNames].sort(),
      disabled: [...disabledNames].sort(),
      skillMountPaths: canonicalSkillMountPathPolicy(policy),
      mountPolicy: canonicalMountPolicy(mountRules),
      drift: details,
    }),
  );
  return hash.digest('hex').slice(0, 16);
}

function sortDriftConflicts(conflicts: DriftConflict[]): DriftConflict[] {
  return conflicts.sort(
    (a, b) =>
      a.skill.localeCompare(b.skill) ||
      a.provider.localeCompare(b.provider) ||
      a.kind.localeCompare(b.kind) ||
      (a.pointsTo ?? '').localeCompare(b.pointsTo ?? ''),
  );
}

// ────────── Mount drift check (shared core) ──────────

async function checkMountDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  expectedSet: ReadonlySet<string>,
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  platformName?: NodeJS.Platform,
): Promise<MountDriftResult> {
  const mountTargets = buildDriftMountTargets(projectRoot, mountRules);
  const missingMounts: string[] = [];
  const conflicts: DriftConflict[] = [];
  const staleMounts = new Set<string>();

  // Legacy directory-level symlink detection
  const legacyDirMounts = new Set<string>();
  const invalidDirMounts = new Map<string, string | undefined>();
  for (const target of mountTargets) {
    try {
      if (await isManagedDirectoryLevelSkillsSymlink(target.dir, skillsSource, platformName)) {
        legacyDirMounts.add(target.key);
      }
    } catch {
      invalidDirMounts.set(target.key, await describeDirectorySymlinkTarget(target.dir));
    }
  }
  if (legacyDirMounts.size > 0) {
    const sourceNames = await listSourceSkillNames(skillsSource);
    for (const name of sourceNames) {
      if (!expectedSet.has(name)) {
        staleMounts.add(name);
        continue;
      }
      if (
        mountTargets.some(
          (t) => legacyDirMounts.has(t.key) && !skillAllowsMountProvider(policy, name, t.provider),
        )
      ) {
        staleMounts.add(name);
      }
    }
  }

  // Forward: each expected skill should have managed symlinks at allowed mount points
  if (mountTargets.length > 0) {
    for (const skillName of expectedSet) {
      let hasMissing = false;
      const skillConflicts: DriftConflict[] = [];
      for (const target of mountTargets.filter((t) => skillAllowsMountProvider(policy, skillName, t.provider))) {
        if (legacyDirMounts.has(target.key)) continue;
        if (invalidDirMounts.has(target.key)) {
          const c: DriftConflict = { skill: skillName, kind: 'other-symlink', provider: target.provider };
          const pt = invalidDirMounts.get(target.key);
          if (pt) c.pointsTo = pt;
          skillConflicts.push(c);
          continue;
        }
        const result = await classifyEntry(join(target.dir, skillName), join(skillsSource, skillName), platformName);
        if (result.kind === 'managed-symlink') continue;
        if (result.kind === 'missing') {
          hasMissing = true;
          continue;
        }
        const c: DriftConflict = { skill: skillName, kind: result.kind, provider: target.provider };
        if (result.kind === 'other-symlink') c.pointsTo = result.pointsTo;
        skillConflicts.push(c);
      }
      if (skillConflicts.length > 0) conflicts.push(...skillConflicts);
      else if (hasMissing) missingMounts.push(skillName);
    }
  }

  // Reverse: scan for stale managed symlinks not in expected set
  for (const target of mountTargets) {
    if (legacyDirMounts.has(target.key) || invalidDirMounts.has(target.key)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(target.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (expectedSet.has(name) && skillAllowsMountProvider(policy, name, target.provider)) continue;
      const result = await classifyEntry(join(target.dir, name), join(skillsSource, name), platformName);
      if (result.kind === 'managed-symlink') staleMounts.add(name);
    }
  }

  return { missingMounts, conflicts, staleMounts };
}

/** Build expected mount set from policy: enabled skills with non-empty mount paths. */
function buildExpectedSet(
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  disabledSet: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const [skill, paths] of policy) {
    if (!disabledSet.has(skill) && paths.size > 0) result.add(skill);
  }
  return result;
}

function finalizeDriftResult(
  newSkills: string[],
  conflicts: DriftConflict[],
  stale: string[],
  expectedSet: ReadonlySet<string>,
  disabledSet: ReadonlySet<string>,
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  mountRules: MountRules,
  projectRoot: string,
): Promise<DriftResult> {
  const sorted = {
    newSkills: newSkills.sort(),
    conflicts: sortDriftConflicts(conflicts),
    stale: stale.sort(),
  };
  const driftHash = computeDriftHash([...expectedSet], [...disabledSet], policy, mountRules, sorted);
  return readProjectState(projectRoot).then((state) => ({
    ...sorted,
    driftHash,
    isIgnored: state.ignoredDriftHash === driftHash,
  }));
}

// ────────── Public API ──────────

/**
 * Global drift check — source ↔ global config + global mount sync.
 * 1.1 Registration: source skills not in global config (unregistered) or vice versa (phantom)
 * 1.2 Mount: global config mountPaths ↔ global project symlinks
 */
export async function checkGlobal(
  globalProjectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts: CheckGlobalOpts,
): Promise<DriftResult> {
  const disabledSet = new Set(opts.disabledSkills);
  const policy = normalizeSkillMountPathPolicy(opts.skillMountPaths);
  const sourceNames = await listSourceSkillNames(skillsSource);
  const sourceSet = new Set(sourceNames);

  // 1.1 Registration: source ↔ global config
  const unregistered = sourceNames.filter((n) => !opts.globalConfigSkills.has(n));
  const phantom = [...opts.globalConfigSkills].filter((n) => !sourceSet.has(n));

  // 1.2 Mount: global config ↔ symlinks
  const expectedSet = buildExpectedSet(policy, disabledSet);
  const mount = await checkMountDrift(globalProjectRoot, skillsSource, mountRules, expectedSet, policy, opts.platformName);

  return finalizeDriftResult(
    [...new Set([...unregistered, ...mount.missingMounts])],
    mount.conflicts,
    [...new Set([...phantom, ...mount.staleMounts])],
    expectedSet,
    disabledSet,
    policy,
    mountRules,
    globalProjectRoot,
  );
}

/**
 * Project drift check — global config ↔ project config + project mount sync.
 * 1. Config sync: skills in global but not project (new) or vice versa (orphan)
 * 2. Mount: project config mountPaths ↔ project symlinks
 */
export async function checkProject(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts: CheckProjectOpts,
): Promise<DriftResult> {
  const disabledSet = new Set(opts.disabledSkills);
  const policy = normalizeSkillMountPathPolicy(opts.skillMountPaths);

  // 1. Config sync: global config ↔ project config
  const configNew: string[] = [];
  const configOrphans: string[] = [];
  for (const skill of opts.globalConfigSkills) {
    if (!disabledSet.has(skill) && !opts.projectConfigSkills.has(skill)) configNew.push(skill);
  }
  for (const skill of opts.projectConfigSkills) {
    if (!opts.globalConfigSkills.has(skill)) configOrphans.push(skill);
  }

  // 2. Mount: project config ↔ symlinks
  const expectedSet = buildExpectedSet(policy, disabledSet);
  const mount = await checkMountDrift(projectRoot, skillsSource, mountRules, expectedSet, policy, opts.platformName);

  return finalizeDriftResult(
    [...new Set([...configNew, ...mount.missingMounts])],
    mount.conflicts,
    [...new Set([...configOrphans, ...mount.staleMounts])],
    expectedSet,
    disabledSet,
    policy,
    mountRules,
    projectRoot,
  );
}

/**
 * Mount-only drift check (backward compat for drift-resolver + tests).
 * Uses source pool as expected set — does NOT perform config-level checks.
 */
export async function detectDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts?: { disabledSkills?: Iterable<string>; skillMountPaths?: SkillMountPathInput; platformName?: NodeJS.Platform },
): Promise<DriftResult> {
  const sourceNames = await listSourceSkillNames(skillsSource);
  const disabledSet = new Set(opts?.disabledSkills ?? []);
  const policy = normalizeSkillMountPathPolicy(opts?.skillMountPaths);
  const expectedSet = new Set(sourceNames.filter((n) => !disabledSet.has(n)));
  const mount = await checkMountDrift(projectRoot, skillsSource, mountRules, expectedSet, policy, opts?.platformName);
  return finalizeDriftResult(
    [...mount.missingMounts],
    mount.conflicts,
    [...mount.staleMounts],
    expectedSet,
    disabledSet,
    policy,
    mountRules,
    projectRoot,
  );
}
