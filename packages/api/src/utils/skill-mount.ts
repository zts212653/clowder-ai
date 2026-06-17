import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DEFAULT_MOUNT_RULES, type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import { pathsEqual } from './project-path.js';
import { resolveStartupProjectRoot } from './startup-root.js';

export type SkillMountPointKey = 'claude' | 'codex' | 'gemini' | 'kimi';

export function buildMountPointDirCandidates(
  projectRoot: string,
  home: string,
  rules: MountRules = DEFAULT_MOUNT_RULES,
): Record<SkillMountPointKey, string[]> {
  const candidatesFor = (id: SkillMountPointKey): string[] => [
    ...new Set([join(projectRoot, rules.mountPoints[id].path), join(home, DEFAULT_MOUNT_RULES.mountPoints[id].path)]),
  ];
  return {
    claude: candidatesFor('claude'),
    codex: candidatesFor('codex'),
    gemini: candidatesFor('gemini'),
    kimi: candidatesFor('kimi'),
  };
}

/**
 * F228: A skill mount target — a mount point directory where a skill symlink
 * may already live or should be created. Replaces the hardcoded 4-mount-point
 * shape returned by `buildMountPointDirCandidates`, and adds support for
 * custom paths (ACP/A2A/unknown clients) via `MountRules.customPaths`.
 */
export interface MountTarget {
  /** Mount point id — standard ('claude' | 'codex' | 'gemini' | 'kimi') or custom alias. */
  id: string;
  /** Standard built-in client vs custom path. */
  kind: 'standard' | 'custom';
  /** Candidate directories (deduped). Standard: [projectDir, homeDir]; Custom: [resolvedPath]. */
  candidates: string[];
}

/**
 * Resolve custom mount paths from MountRules.
 * - absolute paths stay absolute
 * - `~` / `~/...` expands against the user's home directory
 * - project-relative paths resolve under the selected project root
 */
function resolveCustomMountPath(projectRoot: string, path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2));
  if (isAbsolute(path)) return path;
  return join(projectRoot, path);
}

/**
 * F228: Build the full set of skill mount targets a project should consider,
 * derived from `MountRules`. Disabled standard mount points are omitted (their
 * skills directory is not a mount target). Custom paths get one candidate each.
 *
 * Replaces direct callers of `buildMountPointDirCandidates` once mount
 * rules are wired through to API routes (Phase 5).
 */
export function buildSkillMountTargets(
  projectRoot: string,
  home: string,
  rules: MountRules = DEFAULT_MOUNT_RULES,
): MountTarget[] {
  const targets: MountTarget[] = [];
  for (const id of STANDARD_MOUNT_POINT_IDS) {
    const rule = rules.mountPoints[id];
    if (!rule.enabled) continue;
    targets.push({
      id,
      kind: 'standard',
      candidates: [...new Set([join(projectRoot, rule.path), join(home, DEFAULT_MOUNT_RULES.mountPoints[id].path)])],
    });
  }
  for (const cp of rules.customPaths) {
    targets.push({
      id: cp.alias,
      kind: 'custom',
      candidates: [resolveCustomMountPath(projectRoot, cp.path, home)],
    });
  }
  return targets;
}

/**
 * Project-local skill directories where managed skill links can be mounted or
 * cleaned up. Standard mount points intentionally use only the project path here;
 * home-level mount point candidates are for detection/read paths, not writeback.
 */
export function buildProjectSkillMountDirs(
  projectRoot: string,
  home: string,
  rules: MountRules = DEFAULT_MOUNT_RULES,
  opts?: { includeDisabledStandardMountPoints?: boolean },
): string[] {
  const standardDirs = STANDARD_MOUNT_POINT_IDS.flatMap((id) => {
    const rule = rules.mountPoints[id];
    if (!opts?.includeDisabledStandardMountPoints && !rule.enabled) return [];
    return [join(projectRoot, rule.path)];
  });
  const customDirs = buildSkillMountTargets(projectRoot, home, rules)
    .filter((target) => target.kind === 'custom')
    .flatMap((target) => target.candidates);
  return [...new Set([...standardDirs, ...customDirs])];
}

export async function isManagedDirectoryLevelSkillsSymlink(
  skillsDir: string,
  skillsSource: string,
  platformName: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    if (!(await lstat(skillsDir)).isSymbolicLink()) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  let mountedRoot: string;
  let expectedRoot: string;
  try {
    mountedRoot = await realpath(skillsDir);
    expectedRoot = await realpath(skillsSource);
  } catch (err) {
    throw new Error(
      `Invalid directory-level skills mount at ${skillsDir}: symlink must resolve to the current skills source ${skillsSource}. ${
        (err as Error).message
      }`,
    );
  }

  if (!pathsEqual(mountedRoot, expectedRoot, platformName)) {
    throw new Error(
      `Invalid directory-level skills mount at ${skillsDir}: resolves to ${mountedRoot}, expected ${expectedRoot}.`,
    );
  }
  return true;
}

/** Accept symlink target when it points to expected path OR main-repo cat-cafe-skills/{skillName}. */
export async function isCorrectSymlink(
  linkPath: string,
  expectedTarget: string,
  skillName?: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = isAbsolute(dest) ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    const normalizedDest = realDest.replace(/[/\\]$/, '');
    const normalizedExpected = realExpected.replace(/[/\\]$/, '');
    if (pathsEqual(normalizedDest, normalizedExpected)) return true;

    if (skillName && fallbackSkillsRoot) {
      const parentDir = dirname(normalizedDest);
      const nameMatches = normalizedDest.endsWith(`${sep}${skillName}`);
      const isCatCafeSkillsDir = basename(parentDir) === 'cat-cafe-skills';
      const resolvedFallbackRoot = (await realpath(fallbackSkillsRoot).catch(() => fallbackSkillsRoot)).replace(
        /[/\\]$/,
        '',
      );
      const inFallbackRoot = pathsEqual(parentDir, resolvedFallbackRoot);
      const hasManifest = await realpath(join(parentDir, 'manifest.yaml'))
        .then(() => true)
        .catch(() => false);
      const hasSkillMd = await realpath(join(normalizedDest, 'SKILL.md'))
        .then(() => true)
        .catch(() => false);
      if (isCatCafeSkillsDir && inFallbackRoot && nameMatches && hasManifest && hasSkillMd) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function isSkillMountedAtPoint(
  dirCandidates: string[],
  expectedSkillsRoot: string,
  skillName: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  for (const dir of dirCandidates) {
    if (await isCorrectSymlink(dir, expectedSkillsRoot)) return true;
    if (fallbackSkillsRoot && (await isCorrectSymlink(dir, fallbackSkillsRoot))) return true;
    if (
      await isCorrectSymlink(join(dir, skillName), join(expectedSkillsRoot, skillName), skillName, fallbackSkillsRoot)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the project root where this process was started.
 *
 * Delegates to `resolveStartupProjectRoot()` which walks upward from the
 * compiled module directory looking for `cat-cafe-skills/manifest.yaml`.
 * This correctly returns the startup worktree (not the git main worktree).
 */
export async function resolveMainRepoPath(): Promise<string> {
  return resolveStartupProjectRoot();
}
