/**
 * Drift Resolver — F228 Three-Layer Model
 *
 * Applies the user's "sync" decision to a pre-computed DriftResult:
 * pre-deletes conflict paths, then syncProject reconciles.
 *
 * Conflict blockers are backed up before deletion and restored
 * if syncProject fails, preventing user data loss on write errors.
 */

import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MountRules } from '@cat-cafe/shared';
import { withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { isValidSkillName } from '../config/governance/skill-sync.js';
import { buildSkillMountTargets } from '../utils/skill-mount.js';
import type { DriftResult } from './drift-detector.js';
import { syncProject } from './skill-sync-engine.js';

// ────────── Types ──────────

export interface DriftSyncReport {
  mounted: string[];
  unmounted: string[];
  overridden: string[];
  resolvedFrom: DriftResult;
}

export interface SyncDriftOptions {
  disabledSkills?: Iterable<string>;
  skillMountPaths?: Record<string, readonly string[]>;
  globalSkillMountPaths?: Record<string, readonly string[]>;
  cascadeDisabledSkills?: Iterable<string>;
  configOrphans?: Iterable<string>;
}

interface BlockerBackup {
  original: string;
  backup: string;
}

// ────────── Sync Drift ──────────

export function syncDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  drift: DriftResult,
  opts?: SyncDriftOptions,
): Promise<DriftSyncReport> {
  return withCapabilityLock(projectRoot, () => syncDriftUnlocked(projectRoot, skillsSource, mountRules, drift, opts));
}

async function syncDriftUnlocked(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  drift: DriftResult,
  opts?: SyncDriftOptions,
): Promise<DriftSyncReport> {
  // Pre-delete conflict blockers so syncProject sees clean paths.
  // Scope to the specific mount point where the conflict was detected.
  // Blockers are renamed to a backup dir (same filesystem for atomicity)
  // and restored if syncProject fails, preventing user data loss.
  const targets = buildSkillMountTargets(projectRoot, homedir(), mountRules);
  const overriddenSkills = new Set<string>();
  const backups: BlockerBackup[] = [];
  const backupDir = join(projectRoot, '.cat-cafe', '.drift-backup');

  for (const conflict of drift.conflicts ?? []) {
    if (!isValidSkillName(conflict.skill)) continue;
    overriddenSkills.add(conflict.skill);
    const target = targets.find((t) => t.id === conflict.mountPointId);
    if (!target) continue;
    // Standard mount points: only use project path (candidates[0]), skip HOME fallback.
    const dirs = target.kind === 'standard' ? target.candidates.slice(0, 1) : target.candidates;
    for (const dir of dirs) {
      // If the mount point dir path is not a directory (symlink or file blocking it),
      // back up the blocker itself — don't follow symlinks into the source.
      try {
        const stat = await lstat(dir);
        if (!stat.isDirectory()) {
          await mkdir(backupDir, { recursive: true });
          const backupPath = join(backupDir, `dir-${target.id}`);
          await rename(dir, backupPath);
          backups.push({ original: dir, backup: backupPath });
          continue;
        }
      } catch {
        /* ENOENT — dir doesn't exist, nothing to clean */
        continue;
      }
      const conflictPath = join(dir, conflict.skill);
      try {
        await lstat(conflictPath);
      } catch {
        continue; // ENOENT — nothing at this path
      }
      await mkdir(backupDir, { recursive: true });
      const backupPath = join(backupDir, `${target.id}-${conflict.skill}`);
      await rename(conflictPath, backupPath);
      backups.push({ original: conflictPath, backup: backupPath });
    }
  }

  try {
    const syncResult = await syncProject(projectRoot, skillsSource, {
      mountRules,
      disabledSkills: new Set(opts?.disabledSkills ?? []),
      cascadeDisabledSkills: new Set(opts?.cascadeDisabledSkills ?? []),
      mountPathsBySkill: new Map(Object.entries(opts?.skillMountPaths ?? {})),
      globalMountPathsBySkill: new Map(Object.entries(opts?.globalSkillMountPaths ?? {})),
      additionalRemovedSkills: new Set(opts?.configOrphans ?? []),
      preserveGlobalCascade: true,
      force: false,
    });

    // Success: clean up backups
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});

    return {
      mounted: [...new Set(syncResult.mounted.map((m) => m.skillName))].sort(),
      unmounted: [...new Set(syncResult.unmounted.map((u) => u.skillName))].sort(),
      overridden: [...overriddenSkills].sort(),
      resolvedFrom: drift,
    };
  } catch (syncErr) {
    // Restore backed-up conflict blockers so user data is not lost
    for (const { original, backup } of backups) {
      // Remove any managed symlink that syncProject may have created at the original path
      await rm(original, { recursive: true, force: true }).catch(() => {});
      await rename(backup, original).catch(() => {});
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw syncErr;
  }
}
