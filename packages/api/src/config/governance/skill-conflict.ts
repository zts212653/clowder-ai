/**
 * ADR-025 Phase 2: Skill Conflict Detection
 *
 * Detects same-name skills across user-level and project-level directories
 * that resolve to different realpath targets.
 *
 * Claude Code priority: enterprise → personal → project.
 * User-level (personal) shadows project-level, so conflicts mean
 * the user might be running a different version than expected.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const PROVIDER_SKILLS_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

export interface SkillConflict {
  skillName: string;
  projectTarget: string;
  userTarget: string;
  /** Which layer Claude Code would resolve (user shadows project) */
  activeLayer: 'user' | 'project';
}

/**
 * Resolve a skill entry's real path, whether it's a symlink or a real directory.
 * Returns null only if the path doesn't exist at all.
 */
async function resolveSkillTarget(linkPath: string): Promise<string | null> {
  try {
    const s = await lstat(linkPath);
    if (s.isSymbolicLink()) {
      const dest = await readlink(linkPath);
      const abs = isAbsolute(dest) ? dest : resolve(dirname(linkPath), dest);
      return realpath(abs).catch(() => abs);
    }
    if (s.isDirectory()) {
      // Real directory (external install) — resolve its realpath for comparison
      return realpath(linkPath);
    }
    return null;
  } catch {
    return null;
  }
}

function isCatCafeOfficialSkillTarget(target: string, skillName: string): boolean {
  return basename(target) === skillName && basename(dirname(target)) === 'cat-cafe-skills';
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash('sha256');
  const activeDirs = new Set<string>();

  async function walk(dir: string, prefix: string): Promise<void> {
    const realDir = await realpath(dir).catch(() => dir);
    if (activeDirs.has(realDir)) {
      hash.update(`dir-cycle\0${prefix}\0`);
      return;
    }

    activeDirs.add(realDir);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const path = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          hash.update(`dir\0${rel}\0`);
          await walk(path, rel);
          continue;
        }

        if (entry.isSymbolicLink()) {
          await hashSymlink(path, rel);
          continue;
        }

        if (entry.isFile()) {
          hash.update(`file\0${rel}\0`);
          hash.update(await readFile(path));
          hash.update('\0');
        }
      }
    } finally {
      activeDirs.delete(realDir);
    }
  }

  async function hashSymlink(path: string, rel: string): Promise<void> {
    const dest = await readlink(path);
    const abs = isAbsolute(dest) ? dest : resolve(dirname(path), dest);
    const resolved = await realpath(abs);
    const targetStat = await stat(resolved);

    if (targetStat.isDirectory()) {
      hash.update(`link-dir\0${rel}\0`);
      await walk(resolved, rel);
      return;
    }

    if (targetStat.isFile()) {
      hash.update(`link-file\0${rel}\0`);
      hash.update(await readFile(resolved));
      hash.update('\0');
      return;
    }

    hash.update(`link-other\0${rel}\0${targetStat.mode}\0${targetStat.size}\0`);
  }

  await walk(root, '');
  return hash.digest('hex');
}

async function areEquivalentOfficialMirrors(
  skillName: string,
  projectTarget: string,
  userTarget: string,
): Promise<boolean> {
  if (!isCatCafeOfficialSkillTarget(projectTarget, skillName)) return false;
  if (!isCatCafeOfficialSkillTarget(userTarget, skillName)) return false;

  try {
    const [projectHash, userHash] = await Promise.all([hashDirectory(projectTarget), hashDirectory(userTarget)]);
    return projectHash === userHash;
  } catch {
    return false;
  }
}

/**
 * Detect conflicts between project-level and user-level skills.
 * Only checks managed skills (from skills-state.json).
 * Returns one conflict per skill name (first conflicting provider wins).
 */
export async function detectConflicts(
  projectRoot: string,
  homeDir: string,
  managedSkillNames: string[],
): Promise<SkillConflict[]> {
  const conflicts: SkillConflict[] = [];
  const seen = new Set<string>();
  const officialMirrorEquivalence = new Map<string, Promise<boolean>>();

  function isEquivalentOfficialMirror(skillName: string, projectTarget: string, userTarget: string): Promise<boolean> {
    const cacheKey = `${skillName}\0${projectTarget}\0${userTarget}`;
    let result = officialMirrorEquivalence.get(cacheKey);
    if (!result) {
      result = areEquivalentOfficialMirrors(skillName, projectTarget, userTarget);
      officialMirrorEquivalence.set(cacheKey, result);
    }
    return result;
  }

  for (const skillName of managedSkillNames) {
    if (seen.has(skillName)) continue;

    for (const dir of PROVIDER_SKILLS_DIRS) {
      const projectLink = join(projectRoot, dir, skillName);
      const userLink = join(homeDir, dir, skillName);

      const [projectTarget, userTarget] = await Promise.all([
        resolveSkillTarget(projectLink),
        resolveSkillTarget(userLink),
      ]);

      // No conflict if either side is missing
      if (!projectTarget || !userTarget) continue;

      // No conflict if they resolve to the same path
      if (projectTarget === userTarget) continue;

      // Main/runtime worktrees often carry identical Clowder AI official skill mirrors
      // at different realpaths. That is not a user-installed shadow conflict.
      if (await isEquivalentOfficialMirror(skillName, projectTarget, userTarget)) continue;

      conflicts.push({
        skillName,
        projectTarget,
        userTarget,
        activeLayer: 'user', // Claude Code: personal > project
      });
      seen.add(skillName);
      break; // One conflict per skill, don't check other providers
    }
  }

  return conflicts;
}
