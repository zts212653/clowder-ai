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

import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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
