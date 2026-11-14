/**
 * Skill Mount Operations — filesystem-only symlink mount/unmount.
 *
 * Pure filesystem operations: does not read/write capabilities config.
 * Used by addSkill/removeSkill (skill-manage) and capabilities route
 * for per-mount-point toggle reconciliation.
 */

import { lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MountRules } from '@cat-cafe/shared';
import { resolveMountBoundaryEscape } from '../utils/mount-path-boundary.js';
import {
  buildProjectSkillMountDirs,
  buildProjectSkillMountTargets,
  createSkillSymlink,
  ensureSharedSkillRefsMount,
  SHARED_SKILL_REFS_ALIAS,
  symlinkTargetFor,
} from '../utils/skill-mount.js';
import { classifyMountPath, type MountConflict } from './skill-sync-engine.js';

// ────────── Types ──────────

export interface SkillMountResult {
  mounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  unmounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  conflicts: MountConflict[];
}

// ────────── Public API ──────────

/**
 * Mount symlinks for a skill into active mount point directories.
 * Pure filesystem operation — does not touch capabilities config.
 */
export async function mountSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
  mountPaths?: readonly string[],
  sharedSkillsSource = skillsSource,
): Promise<SkillMountResult> {
  const result: SkillMountResult = { mounted: [], unmounted: [], conflicts: [] };
  const targets = buildProjectSkillMountTargets(projectRoot, homedir(), mountRules);
  const allowed = mountPaths ? new Set(mountPaths) : null;

  for (const target of targets) {
    if (allowed && !allowed.has(target.id)) {
      for (const dir of target.dirs) {
        // Guard: skip symlinked mount dirs (same as mount branch below)
        try {
          const s = await lstat(dir);
          if (s.isSymbolicLink() || !s.isDirectory()) continue;
        } catch {
          continue;
        }
        const linkPath = join(dir, skillName);
        if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
          await rm(linkPath);
          result.unmounted.push({ skillName, mountPointId: target.id, path: linkPath });
        }
      }
      continue;
    }
    for (const dir of target.dirs) {
      if (await resolveMountBoundaryEscape(projectRoot, dir)) {
        console.warn(`[mountSkillSymlinks] Skipping skill mount outside project root: ${dir}`);
        result.conflicts.push({ skillName, mountPointId: target.id, path: join(dir, skillName) });
        continue;
      }
      // Guard: reject symlinked mount dirs to prevent writing outside project
      try {
        const dirStat = await lstat(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          result.conflicts.push({ skillName, mountPointId: target.id, path: dir });
          continue;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          result.conflicts.push({ skillName, mountPointId: target.id, path: dir });
          continue;
        }
      }
      await mkdir(dir, { recursive: true });
      if ((await ensureSharedSkillRefsMount(dir, sharedSkillsSource)) === 'conflict') {
        result.conflicts.push({
          skillName: SHARED_SKILL_REFS_ALIAS,
          mountPointId: target.id,
          path: join(dir, SHARED_SKILL_REFS_ALIAS),
        });
      }
      const linkPath = join(dir, skillName);
      const status = await classifyMountPath(linkPath, skillsSource, skillName);
      if (status === 'missing') {
        await createSkillSymlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
        result.mounted.push({ skillName, mountPointId: target.id, path: linkPath });
      } else if (status === 'conflict') {
        result.conflicts.push({ skillName, mountPointId: target.id, path: linkPath });
      }
    }
  }
  return result;
}

/**
 * Remove managed symlinks for a skill from all mount point directories.
 * Pure filesystem operation — does not touch capabilities config.
 */
export async function unmountSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
): Promise<SkillMountResult> {
  const result: SkillMountResult = { mounted: [], unmounted: [], conflicts: [] };
  for (const dir of buildProjectSkillMountDirs(projectRoot, homedir(), mountRules, {
    includeDisabledStandardMountPoints: true,
  })) {
    // Guard: skip symlinked mount dirs to avoid following into external targets
    try {
      const dirStat = await lstat(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    const linkPath = join(dir, skillName);
    if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
      await rm(linkPath);
      result.unmounted.push({ skillName, mountPointId: 'cleanup', path: linkPath });
    }
  }
  return result;
}
