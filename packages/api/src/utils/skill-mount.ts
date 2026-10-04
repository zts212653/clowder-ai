import { lstat, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_MOUNT_RULES, type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import { pathsEqual } from './project-path.js';
import { resolveStartupProjectRoot } from './startup-root.js';

export type SkillMountPointKey = 'claude' | 'codex' | 'gemini' | 'kimi';

export const SHARED_SKILL_REFS_ALIAS = '.cat-cafe-shared-refs';

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

/**
 * Create a symlink with Windows junction fallback.
 *
 * On Windows, `fs.symlink()` requires Developer Mode or admin privileges.
 * When it fails with EPERM, we fall back to a junction — junctions work
 * without special privileges for directories. `symlinkTargetFor()` already
 * returns an absolute path on Windows, which junctions require.
 */
export async function createSkillSymlink(target: string, path: string): Promise<void> {
  try {
    await symlink(target, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      await symlink(target, path, 'junction');
    } else {
      throw err;
    }
  }
}

/**
 * Keep shared skill refs addressable from a provider mount without depending on
 * whether the runtime resolves the per-skill symlink before normalizing `..`.
 */
export async function ensureSharedSkillRefsMount(
  skillsDir: string,
  skillsSource: string,
): Promise<'created' | 'existing' | 'conflict' | 'source-missing'> {
  const sharedRefsSource = join(skillsSource, 'refs');
  try {
    if (!(await lstat(sharedRefsSource)).isDirectory()) return 'source-missing';
  } catch {
    return 'source-missing';
  }

  const aliasPath = join(skillsDir, SHARED_SKILL_REFS_ALIAS);
  try {
    const status = await lstat(aliasPath);
    if (!status.isSymbolicLink()) return 'conflict';
    const current = await readlink(aliasPath);
    const currentTarget = isAbsolute(current) ? current : resolve(dirname(aliasPath), current);
    const [realCurrent, realExpected] = await Promise.all([
      realpath(currentTarget).catch(() => currentTarget),
      realpath(sharedRefsSource).catch(() => sharedRefsSource),
    ]);
    return pathsEqual(realCurrent, realExpected) ? 'existing' : 'conflict';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'conflict';
  }

  const target = process.platform === 'win32' ? sharedRefsSource : relative(dirname(aliasPath), sharedRefsSource);
  await createSkillSymlink(target, aliasPath);
  return 'created';
}

/** Remove the reserved coordinate only when it is one of our managed links. */
export async function removeSharedSkillRefsMount(skillsDir: string, skillsSource: string): Promise<boolean> {
  const aliasPath = join(skillsDir, SHARED_SKILL_REFS_ALIAS);
  try {
    const skillsDirStatus = await lstat(skillsDir);
    if (skillsDirStatus.isSymbolicLink() || !skillsDirStatus.isDirectory()) return false;
    if (!(await lstat(aliasPath)).isSymbolicLink()) return false;
    const current = await readlink(aliasPath);
    const currentTarget = isAbsolute(current) ? current : resolve(dirname(aliasPath), current);
    const expectedTarget = join(skillsSource, 'refs');
    const [realCurrent, realExpected] = await Promise.all([
      realpath(currentTarget).catch(() => currentTarget),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    if (!pathsEqual(realCurrent, realExpected)) return false;
    await rm(aliasPath);
    return true;
  } catch {
    return false;
  }
}

/** Accept symlink target when it points to expected path OR main-repo cat-cafe-skills/{skillName}. */
export async function isCorrectSymlink(
  linkPath: string,
  expectedTarget: string,
  skillName?: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  return (await inspectSkillSymlink(linkPath, expectedTarget, skillName, fallbackSkillsRoot)).state === 'correct';
}

/**
 * `correct` / `incorrect` are observations; `unknown` means a path existed but
 * could not be read (`CODE:path` in `gaps`). `isCorrectSymlink` folds unknown
 * into `false` for writers that only act on a confirmed mount; readers that
 * report what they saw use this instead (F300 2.1 review R2 P1-2).
 */
export type SymlinkInspection =
  | { readonly state: 'correct' }
  | { readonly state: 'incorrect' }
  | { readonly state: 'unknown'; readonly gaps: readonly string[] };

/** Not-there is an answer; anything else that stops a read is a gap. */
function readGap(error: unknown, path: string): string | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return null;
  return `${code ?? 'EUNKNOWN'}:${path}`;
}

/** realpath, or the lexical path when the target does not exist (a dangling link is still comparable). */
async function realpathOrLexical(path: string, gaps: string[]): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const gap = readGap(error, path);
    if (gap) gaps.push(gap);
    return path;
  }
}

async function existsOrGap(path: string, gaps: string[]): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    const gap = readGap(error, path);
    if (gap) gaps.push(gap);
    return false;
  }
}

export async function inspectSkillSymlink(
  linkPath: string,
  expectedTarget: string,
  skillName?: string,
  fallbackSkillsRoot?: string,
): Promise<SymlinkInspection> {
  let isLink: boolean;
  let dest: string;
  try {
    isLink = (await lstat(linkPath)).isSymbolicLink();
    if (!isLink) return { state: 'incorrect' };
    dest = await readlink(linkPath);
  } catch (error) {
    const gap = readGap(error, linkPath);
    return gap ? { state: 'unknown', gaps: [gap] } : { state: 'incorrect' };
  }
  const gaps: string[] = [];
  const absDest = isAbsolute(dest) ? dest : resolve(dirname(linkPath), dest);
  const [realDest, realExpected] = await Promise.all([
    realpathOrLexical(absDest, gaps),
    realpathOrLexical(expectedTarget, gaps),
  ]);
  const normalizedDest = realDest.replace(/[/\\]$/, '');
  const normalizedExpected = realExpected.replace(/[/\\]$/, '');
  // A comparison made on a path we could not resolve is not an observation.
  const settle = (matched: boolean): SymlinkInspection =>
    gaps.length > 0 ? { state: 'unknown', gaps } : { state: matched ? 'correct' : 'incorrect' };
  if (pathsEqual(normalizedDest, normalizedExpected)) return settle(true);

  if (skillName && fallbackSkillsRoot) {
    const parentDir = dirname(normalizedDest);
    const nameMatches = normalizedDest.endsWith(`${sep}${skillName}`);
    const isCatCafeSkillsDir = basename(parentDir) === 'cat-cafe-skills';
    const resolvedFallbackRoot = (await realpathOrLexical(fallbackSkillsRoot, gaps)).replace(/[/\\]$/, '');
    const inFallbackRoot = pathsEqual(parentDir, resolvedFallbackRoot);
    const hasManifest = await existsOrGap(join(parentDir, 'manifest.yaml'), gaps);
    const hasSkillMd = await existsOrGap(join(normalizedDest, 'SKILL.md'), gaps);
    if (isCatCafeSkillsDir && inFallbackRoot && nameMatches && hasManifest && hasSkillMd) return settle(true);
  }
  return settle(false);
}

export async function isSkillMountedAtPoint(
  dirCandidates: string[],
  expectedSkillsRoot: string,
  skillName: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  return (
    (await inspectSkillMountAtPoint(dirCandidates, expectedSkillsRoot, skillName, fallbackSkillsRoot)).state ===
    'mounted'
  );
}

export type SkillMountInspection =
  | { readonly state: 'mounted' }
  | { readonly state: 'not_mounted' }
  | { readonly state: 'unknown'; readonly gaps: readonly string[] };

/** Same checks and order as `isSkillMountedAtPoint`; a confirmed mount anywhere wins over gaps elsewhere. */
export async function inspectSkillMountAtPoint(
  dirCandidates: string[],
  expectedSkillsRoot: string,
  skillName: string,
  fallbackSkillsRoot?: string,
): Promise<SkillMountInspection> {
  const gaps: string[] = [];
  for (const dir of dirCandidates) {
    const inspections = [
      () => inspectSkillSymlink(dir, expectedSkillsRoot),
      ...(fallbackSkillsRoot ? [() => inspectSkillSymlink(dir, fallbackSkillsRoot)] : []),
      () =>
        inspectSkillSymlink(join(dir, skillName), join(expectedSkillsRoot, skillName), skillName, fallbackSkillsRoot),
    ];
    for (const inspect of inspections) {
      const result = await inspect();
      if (result.state === 'correct') return { state: 'mounted' };
      if (result.state === 'unknown') gaps.push(...result.gaps);
    }
  }
  return gaps.length > 0 ? { state: 'unknown', gaps: [...new Set(gaps)] } : { state: 'not_mounted' };
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
