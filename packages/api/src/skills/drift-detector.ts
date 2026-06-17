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
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import { pathsEqual } from '../utils/project-path.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import {
  canonicalSkillMountPathPolicy,
  normalizeSkillMountPathPolicy,
  type SkillMountPathInput,
  skillAllowsMountPoint,
} from '../utils/skill-mount-policy.js';
import { listSourceSkillNames } from '../utils/skill-source.js';

// ────────── Exported types ──────────

export interface DriftConflict {
  skill: string;
  kind: 'other-symlink' | 'directory' | 'file';
  mountPointId: string;
  pointsTo?: string;
}

/**
 * F228: the fixed anomaly scenarios the detector recognizes. Each maps to a
 * single display-ready message so the frontend renders verbatim (no client-side
 * re-computation / cross-referencing of separate endpoints).
 */
export type SkillIssueType =
  | 'conflict' // mount point occupied by a same-name dir/file/foreign link
  | 'mount-missing' // expected mount point has no managed symlink
  | 'unregistered' // source skill not enabled in global config (global scope)
  | 'phantom' // global config skill no longer in source (global scope)
  | 'config-new' // global has skill, project lacks it (project scope)
  | 'config-orphan' // project has skill, global removed it (project scope)
  | 'stale-mount'; // managed symlink that is no longer wanted

/** One display-ready anomaly for a single skill. */
export interface SkillIssue {
  skill: string;
  type: SkillIssueType;
  /** Mount-point id for conflict / mount-missing issues. */
  mountPointId?: string;
  /** Fully-formed Chinese message; rendered verbatim by the UI. */
  message: string;
}

export interface DriftResult {
  newSkills: string[];
  conflicts: DriftConflict[];
  stale: string[];
  /** F228: display-ready, de-duplicated per-skill anomaly list (single source of truth). */
  issues: SkillIssue[];
  /** Stable state fingerprint over the raw drift buckets. */
  driftHash: string;
}

// ────────── Issue messages (F228 spec §挂载冲突处理 line 236) ──────────

const CONFLICT_KIND_LABEL: Record<DriftConflict['kind'], string> = {
  directory: '存在同名目录占用',
  file: '存在同名文件占用',
  'other-symlink': '存在同名链接占用',
};
const CONFLICT_OVERWRITE_WARNING = '立即同步会覆盖和清理已有内容，请先确认是否需要进行备份';

const ISSUE_TYPE_ORDER: SkillIssueType[] = [
  'conflict',
  'mount-missing',
  'config-new',
  'config-orphan',
  'unregistered',
  'phantom',
  'stale-mount',
];

function conflictToIssue(conflict: DriftConflict): SkillIssue {
  const occupancy = CONFLICT_KIND_LABEL[conflict.kind];
  const pointer = conflict.pointsTo ? ` → ${conflict.pointsTo}` : '';
  return {
    skill: conflict.skill,
    type: 'conflict',
    mountPointId: conflict.mountPointId,
    message: `${conflict.mountPointId} ${occupancy}${pointer}（${CONFLICT_OVERWRITE_WARNING}）`,
  };
}

function sortSkillIssues(issues: SkillIssue[]): SkillIssue[] {
  return issues.sort(
    (a, b) =>
      a.skill.localeCompare(b.skill) ||
      ISSUE_TYPE_ORDER.indexOf(a.type) - ISSUE_TYPE_ORDER.indexOf(b.type) ||
      (a.mountPointId ?? '').localeCompare(b.mountPointId ?? ''),
  );
}

/**
 * Build the display-ready issue list from the distinct scenario buckets.
 * Scenarios are naturally disjoint per (skill, type) — a skill with a mount
 * conflict is not also reported as mount-missing (checkMountDrift), and
 * registration/config buckets concern skills outside the mount expected-set —
 * so no de-dup pass is needed here.
 */
function buildSkillIssues(scenarios: {
  conflicts: DriftConflict[];
  missingMounts: ReadonlyArray<{ skill: string; mountPointIds: string[] }>;
  staleMounts: Iterable<string>;
  unregistered?: Iterable<string>;
  phantom?: Iterable<string>;
  configNew?: Iterable<string>;
  configOrphans?: Iterable<string>;
}): SkillIssue[] {
  const issues: SkillIssue[] = [];
  for (const conflict of scenarios.conflicts) issues.push(conflictToIssue(conflict));
  for (const missing of scenarios.missingMounts) {
    issues.push({
      skill: missing.skill,
      type: 'mount-missing',
      message: missing.mountPointIds.length > 0 ? `${missing.mountPointIds.join('、')} 未挂载` : '挂载缺失',
    });
  }
  for (const skill of scenarios.configNew ?? []) {
    issues.push({ skill, type: 'config-new', message: '全局已启用，待同步到本项目' });
  }
  for (const skill of scenarios.configOrphans ?? []) {
    issues.push({ skill, type: 'config-orphan', message: '本项目残留，全局已移除' });
  }
  for (const skill of scenarios.unregistered ?? []) {
    issues.push({ skill, type: 'unregistered', message: '源中存在但未在全局启用' });
  }
  for (const skill of scenarios.phantom ?? []) {
    issues.push({ skill, type: 'phantom', message: '已在全局启用但源中已删除' });
  }
  for (const skill of scenarios.staleMounts) {
    issues.push({ skill, type: 'stale-mount', message: '存在多余挂载，需清理' });
  }
  return sortSkillIssues(issues);
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
  mountPointId: string;
  dir: string;
}

interface MountDriftResult {
  /** Skills with at least one missing managed symlink, with the missing mount point ids. */
  missingMounts: Array<{ skill: string; mountPointIds: string[] }>;
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
    mountPoints: Object.fromEntries(
      STANDARD_MOUNT_POINT_IDS.map((id) => {
        const rule = mountRules.mountPoints[id];
        return [id, { enabled: rule.enabled, path: rule.enabled ? rule.path : '' }];
      }),
    ),
    customPaths: [...mountRules.customPaths]
      .map((entry) => ({ alias: entry.alias, path: entry.path }))
      .sort((a, b) => a.alias.localeCompare(b.alias) || a.path.localeCompare(b.path)),
  };
}

function buildDriftMountTargets(projectRoot: string, mountRules: MountRules): DriftMountTarget[] {
  const standardTargets = STANDARD_MOUNT_POINT_IDS.flatMap((id) => {
    const rule = mountRules.mountPoints[id];
    if (!rule.enabled) return [];
    const dir = join(projectRoot, rule.path);
    return [{ key: `standard:${id}:${dir}`, mountPointId: id, dir }];
  });
  const customTargets = buildSkillMountTargets(projectRoot, homedir(), mountRules)
    .filter((target) => target.kind === 'custom')
    .flatMap((target) =>
      target.candidates.map((dir) => ({
        key: `custom:${target.id}:${dir}`,
        mountPointId: target.id,
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
      a.mountPointId.localeCompare(b.mountPointId) ||
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
  const missingMounts: Array<{ skill: string; mountPointIds: string[] }> = [];
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
        mountTargets.some((t) => legacyDirMounts.has(t.key) && !skillAllowsMountPoint(policy, name, t.mountPointId))
      ) {
        staleMounts.add(name);
      }
    }
  }

  // Forward: each expected skill should have managed symlinks at allowed mount points
  if (mountTargets.length > 0) {
    for (const skillName of expectedSet) {
      const missingMountPoints: string[] = [];
      const skillConflicts: DriftConflict[] = [];
      for (const target of mountTargets.filter((t) => skillAllowsMountPoint(policy, skillName, t.mountPointId))) {
        if (legacyDirMounts.has(target.key)) continue;
        if (invalidDirMounts.has(target.key)) {
          const c: DriftConflict = { skill: skillName, kind: 'other-symlink', mountPointId: target.mountPointId };
          const pt = invalidDirMounts.get(target.key);
          if (pt) c.pointsTo = pt;
          skillConflicts.push(c);
          continue;
        }
        const result = await classifyEntry(join(target.dir, skillName), join(skillsSource, skillName), platformName);
        if (result.kind === 'managed-symlink') continue;
        if (result.kind === 'missing') {
          missingMountPoints.push(target.mountPointId);
          continue;
        }
        const c: DriftConflict = { skill: skillName, kind: result.kind, mountPointId: target.mountPointId };
        if (result.kind === 'other-symlink') c.pointsTo = result.pointsTo;
        skillConflicts.push(c);
      }
      // Conflict supersedes mount-missing for the same skill (a blocked provider
      // is reported once, as a conflict — not also as "missing").
      if (skillConflicts.length > 0) conflicts.push(...skillConflicts);
      else if (missingMountPoints.length > 0)
        missingMounts.push({ skill: skillName, mountPointIds: missingMountPoints });
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
      if (expectedSet.has(name) && skillAllowsMountPoint(policy, name, target.mountPointId)) continue;
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
  issues: SkillIssue[],
  expectedSet: ReadonlySet<string>,
  disabledSet: ReadonlySet<string>,
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  mountRules: MountRules,
): DriftResult {
  const sorted = {
    newSkills: newSkills.sort(),
    conflicts: sortDriftConflicts(conflicts),
    stale: stale.sort(),
  };
  // driftHash is a stable state fingerprint over the raw buckets.
  const driftHash = computeDriftHash([...expectedSet], [...disabledSet], policy, mountRules, sorted);
  return { ...sorted, issues, driftHash };
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
  const mount = await checkMountDrift(
    globalProjectRoot,
    skillsSource,
    mountRules,
    expectedSet,
    policy,
    opts.platformName,
  );

  const issues = buildSkillIssues({
    conflicts: mount.conflicts,
    missingMounts: mount.missingMounts,
    staleMounts: mount.staleMounts,
    unregistered,
    phantom,
  });

  return finalizeDriftResult(
    [...new Set([...unregistered, ...mount.missingMounts.map((m) => m.skill)])],
    mount.conflicts,
    [...new Set([...phantom, ...mount.staleMounts])],
    issues,
    expectedSet,
    disabledSet,
    policy,
    mountRules,
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
  // Exclude orphans: skills in project config but not global config belong in stale,
  // not in mount detection — prevents same skill appearing in both newSkills and stale (P1-2).
  const orphanSet = new Set(configOrphans);
  const expectedSet = buildExpectedSet(policy, disabledSet);
  for (const orphan of orphanSet) expectedSet.delete(orphan);
  const mount = await checkMountDrift(projectRoot, skillsSource, mountRules, expectedSet, policy, opts.platformName);

  const issues = buildSkillIssues({
    conflicts: mount.conflicts,
    missingMounts: mount.missingMounts,
    staleMounts: mount.staleMounts,
    configNew,
    configOrphans,
  });

  return finalizeDriftResult(
    [...new Set([...configNew, ...mount.missingMounts.map((m) => m.skill)])],
    mount.conflicts,
    [...new Set([...configOrphans, ...mount.staleMounts])],
    issues,
    expectedSet,
    disabledSet,
    policy,
    mountRules,
  );
}
