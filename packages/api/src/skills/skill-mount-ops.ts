/**
 * Skill Mount Operations — filesystem-only symlink mount/unmount.
 *
 * Pure filesystem operations: does not read/write capabilities config.
 * Used by addSkill/removeSkill (skill-manage) and capabilities route
 * for per-mount-point toggle reconciliation.
 */

import { lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import {
  buildSkillMountTargets,
  createSkillSymlink,
  ensureSharedSkillRefsMount,
  SHARED_SKILL_REFS_ALIAS,
} from '../utils/skill-mount.js';
import { classifyMountPath, type MountConflict } from './skill-sync-engine.js';

// ────────── Types ──────────

export interface MountTarget {
  id: string;
  dirs: string[];
}

export interface SkillMountResult {
  mounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  unmounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  conflicts: MountConflict[];
}

// ────────── Internals ──────────

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

export function activeMountTargets(projectRoot: string, rules: MountRules): MountTarget[] {
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
  const targets = activeMountTargets(projectRoot, mountRules);
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
  for (const dir of allMountDirs(projectRoot, mountRules)) {
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
