/**
 * Drift Detector — F228 Phase 2
 *
 * Compares the project's actual mounted symlinks against the expected
 * mount set (source pool ∖ disabled-in-policy) for every active mount target
 * in MountRules. Returns three categories:
 *
 *   - newSkills: expected but not mounted in every active target
 *   - conflicts: expected but blocked by a same-name non-managed local path
 *                (directory, file, or symlink pointing elsewhere)
 *   - stale: managed symlinks for skills no longer in the expected set
 *            (skill removed from source OR newly disabled)
 *
 * The driftHash lets the user choose "ignore until something changes" —
 * markDriftIgnored stores it in project-state.json so subsequent checks with
 * the same hash return isIgnored=true.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { listSourceSkillNames } from '../config/governance/skills-state.js';
import { readProjectState } from '../config/mount/project-state-store.js';
import { pathsEqual } from '../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import {
  canonicalSkillMountPathPolicy,
  normalizeSkillMountPathPolicy,
  type SkillMountPathInput,
  skillAllowsMountProvider,
} from '../utils/skill-mount-policy.js';

export interface DriftConflict {
  /** Skill name that wanted to mount but found something in the way. */
  skill: string;
  /** What kind of file is blocking the mount path. */
  kind: 'other-symlink' | 'directory' | 'file';
  /** First provider where the conflict was observed (claude/codex/gemini/kimi). */
  provider: string;
  /** For other-symlink only: where it points. */
  pointsTo?: string;
}

export interface DriftResult {
  /** Skills in the expected set but missing from at least one enabled provider. */
  newSkills: string[];
  /** Same-name local paths blocking expected mounts. */
  conflicts: DriftConflict[];
  /** Managed symlinks for skills no longer expected (source-removed or disabled). */
  stale: string[];
  /** Stable hash of source/policy plus computed filesystem drift details for "ignore this drift" UX. */
  driftHash: string;
  /** True iff driftHash matches projectState.ignoredDriftHash (user previously hit "ignore"). */
  isIgnored: boolean;
}

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
  sourceNames: readonly string[],
  disabledNames: readonly string[],
  skillMountPathPolicy: ReadonlyMap<string, ReadonlySet<string>>,
  mountRules: MountRules,
  driftDetails: Pick<DriftResult, 'newSkills' | 'conflicts' | 'stale'>,
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      source: [...sourceNames].sort(),
      disabled: [...disabledNames].sort(),
      skillMountPaths: canonicalSkillMountPathPolicy(skillMountPathPolicy),
      mountPolicy: canonicalMountPolicy(mountRules),
      drift: driftDetails,
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

export async function detectDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts?: { disabledSkills?: Iterable<string>; skillMountPaths?: SkillMountPathInput; platformName?: NodeJS.Platform },
): Promise<DriftResult> {
  const sourceNames = await listSourceSkillNames(skillsSource);
  const disabledSet = new Set(opts?.disabledSkills ?? []);
  const skillMountPathPolicy = normalizeSkillMountPathPolicy(opts?.skillMountPaths);
  const expectedSet = new Set(sourceNames.filter((n) => !disabledSet.has(n)));
  const mountTargets = buildDriftMountTargets(projectRoot, mountRules);

  const newSkills: string[] = [];
  const conflicts: DriftConflict[] = [];
  const staleSet = new Set<string>();
  const legacyDirectoryMounts = new Set<string>();
  const invalidDirectoryMounts = new Map<string, string | undefined>();
  for (const target of mountTargets) {
    try {
      if (await isManagedDirectoryLevelSkillsSymlink(target.dir, skillsSource, opts?.platformName)) {
        legacyDirectoryMounts.add(target.key);
      }
    } catch {
      invalidDirectoryMounts.set(target.key, await describeDirectorySymlinkTarget(target.dir));
    }
  }
  if (legacyDirectoryMounts.size > 0) {
    for (const skillName of sourceNames) {
      if (disabledSet.has(skillName)) {
        staleSet.add(skillName);
        continue;
      }
      if (
        mountTargets.some(
          (target) =>
            legacyDirectoryMounts.has(target.key) &&
            !skillAllowsMountProvider(skillMountPathPolicy, skillName, target.provider),
        )
      ) {
        staleSet.add(skillName);
      }
    }
  }

  if (mountTargets.length > 0) {
    // 1) For each expected skill: every active mount target must hold a managed symlink.
    //    If any provider is missing, sync can safely re-mount the skill everywhere.
    //    If any provider has a blocker, report the conflict instead of auto-replacing it.
    for (const skillName of expectedSet) {
      let hasMissingMount = false;
      const skillConflicts: DriftConflict[] = [];
      for (const target of mountTargets.filter((entry) =>
        skillAllowsMountProvider(skillMountPathPolicy, skillName, entry.provider),
      )) {
        if (legacyDirectoryMounts.has(target.key)) continue;
        const invalidMountTarget = invalidDirectoryMounts.get(target.key);
        if (invalidDirectoryMounts.has(target.key)) {
          const c: DriftConflict = { skill: skillName, kind: 'other-symlink', provider: target.provider };
          if (invalidMountTarget) c.pointsTo = invalidMountTarget;
          skillConflicts.push(c);
          continue;
        }
        const entryPath = join(target.dir, skillName);
        const expectedTarget = join(skillsSource, skillName);
        const result = await classifyEntry(entryPath, expectedTarget, opts?.platformName);
        if (result.kind === 'managed-symlink') {
          continue;
        }
        if (result.kind === 'missing') {
          hasMissingMount = true;
          continue;
        }
        const c: DriftConflict = { skill: skillName, kind: result.kind, provider: target.provider };
        if (result.kind === 'other-symlink') c.pointsTo = result.pointsTo;
        skillConflicts.push(c);
      }
      if (skillConflicts.length > 0) conflicts.push(...skillConflicts);
      else if (hasMissingMount) newSkills.push(skillName);
    }
  }

  // 2) Scan each active mount target for entries that are NOT in the expected set.
  //    Managed symlinks pointing at source → stale (skill removed or now disabled).
  //    Anything else → user-owned, not our concern.
  for (const target of mountTargets) {
    if (legacyDirectoryMounts.has(target.key)) continue;
    if (invalidDirectoryMounts.has(target.key)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(target.dir);
    } catch {
      continue;
    }
    for (const entryName of entries) {
      if (expectedSet.has(entryName) && skillAllowsMountProvider(skillMountPathPolicy, entryName, target.provider)) {
        continue;
      }
      const entryPath = join(target.dir, entryName);
      const result = await classifyEntry(entryPath, join(skillsSource, entryName), opts?.platformName);
      if (result.kind === 'managed-symlink') {
        staleSet.add(entryName);
      }
    }
  }

  const sortedNewSkills = newSkills.sort();
  const sortedConflicts = sortDriftConflicts(conflicts);
  const sortedStale = [...staleSet].sort();
  const driftHash = computeDriftHash(sourceNames, [...disabledSet], skillMountPathPolicy, mountRules, {
    newSkills: sortedNewSkills,
    conflicts: sortedConflicts,
    stale: sortedStale,
  });
  const state = await readProjectState(projectRoot);
  const isIgnored = state.ignoredDriftHash === driftHash;

  return {
    newSkills: sortedNewSkills,
    conflicts: sortedConflicts,
    stale: sortedStale,
    driftHash,
    isIgnored,
  };
}
