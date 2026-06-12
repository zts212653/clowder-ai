/**
 * Drift Resolver — F228 redesign
 *
 * Applies the user's "sync" or "ignore" decision to the current DriftResult.
 * Uses syncProject as the unified reconciliation engine:
 *
 *   - action='sync': pre-deletes override conflict paths, then syncProject
 *     reconciles the entire project (mount new, remove stale, skip remaining conflicts).
 *
 *   - action='ignore': marks the current driftHash as ignored in projectState.
 */

import { lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MountRules } from '@cat-cafe/shared';
import { clearDriftIgnored, markDriftIgnored } from '../config/mount/project-state-store.js';
import { buildSkillMountTargets } from '../utils/skill-mount.js';
import type { SkillMountPathInput } from '../utils/skill-mount-policy.js';
import { type DriftResult, detectDrift } from './drift-detector.js';
import { syncProject } from './skill-sync-engine.js';

// ────────── Types (inlined from deleted drift-helpers.ts) ──────────

export type ConflictChoice = 'override' | 'skip';

export interface DriftSyncReport {
  /** Skills successfully mounted (newSkills + overridden conflicts). */
  mounted: string[];
  /** Skills whose symlinks were removed (stale set). */
  unmounted: string[];
  /** Conflicts the user chose 'override' for — local path was deleted + symlink created. */
  overridden: string[];
  /** Conflicts the user chose 'skip' for — left alone. */
  skipped: string[];
  /** The drift snapshot used for this sync (post-sync state will be different). */
  resolvedFrom: DriftResult;
}

export interface DriftIgnoreReport {
  /** The driftHash that is now ignored. */
  ignoredHash: string;
  /** The drift snapshot at ignore time. */
  ignoredSnapshot: DriftResult;
}

// ────────── Sync Drift ──────────

export async function syncDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  conflictChoices: Record<string, ConflictChoice>,
  opts?: {
    disabledSkills?: Iterable<string>;
    skillMountPaths?: SkillMountPathInput;
    cascadeDisabledSkills?: Iterable<string>;
  },
): Promise<DriftSyncReport> {
  const drift = await detectDrift(projectRoot, skillsSource, mountRules, opts);

  // Pre-delete override conflict paths so syncProject sees them as 'missing'
  const overriddenKeys = new Set<string>();
  const targets = buildSkillMountTargets(projectRoot, homedir(), mountRules);
  for (const conflict of drift.conflicts) {
    const key = `${conflict.skill}:${conflict.provider}`;
    if ((conflictChoices[key] ?? 'skip') === 'override') {
      overriddenKeys.add(key);
      const target = targets.find((t) => t.id === conflict.provider);
      if (target) {
        for (const dir of target.candidates) {
          // Remove skill-level blocker
          await rm(join(dir, conflict.skill), { recursive: true, force: true }).catch(() => {});
          // Also remove root-level blocker (non-directory symlink/file)
          try {
            const rootStat = await lstat(dir);
            if (rootStat.isSymbolicLink() || rootStat.isFile()) await rm(dir, { force: true });
          } catch {
            /* ENOENT — fine */
          }
        }
      }
    }
  }

  // Clear drift-ignored state so future drifts trigger normally
  await clearDriftIgnored(projectRoot);

  // Reconcile the entire project via syncProject
  const disabledSet = new Set(opts?.disabledSkills ?? []);
  const cascadeDisabledSet = new Set(opts?.cascadeDisabledSkills ?? []);
  // Convert skillMountPaths (Record | Map) → Map for syncProject
  const mountPathsBySkill = new Map<string, readonly string[]>();
  if (opts?.skillMountPaths) {
    const input = opts.skillMountPaths;
    const entries =
      typeof (input as ReadonlyMap<string, readonly string[]>).entries === 'function'
        ? (input as ReadonlyMap<string, readonly string[]>).entries()
        : Object.entries(input as Record<string, readonly string[]>);
    for (const [k, v] of entries) mountPathsBySkill.set(k, v);
  }

  const syncResult = await syncProject(projectRoot, skillsSource, {
    mountRules,
    disabledSkills: disabledSet,
    cascadeDisabledSkills: cascadeDisabledSet,
    mountPathsBySkill,
    force: false, // Overrides were pre-deleted; remaining conflicts should skip
  });

  // Build report from drift + syncProject result
  const overriddenSkills = new Set<string>();
  const skippedSkills = new Set<string>();
  for (const conflict of drift.conflicts) {
    const key = `${conflict.skill}:${conflict.provider}`;
    if (overriddenKeys.has(key)) {
      overriddenSkills.add(conflict.skill);
    } else {
      skippedSkills.add(conflict.skill);
    }
  }

  const mountedSkills = new Set(syncResult.mounted.map((m) => m.skillName));
  const unmountedSkills = new Set(syncResult.unmounted.map((u) => u.skillName));

  return {
    mounted: [...mountedSkills].sort(),
    unmounted: [...unmountedSkills].sort(),
    overridden: [...overriddenSkills].sort(),
    skipped: [...skippedSkills].sort(),
    resolvedFrom: drift,
  };
}

// ────────── Ignore Drift ──────────

export async function ignoreDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  opts?: { disabledSkills?: Iterable<string>; skillMountPaths?: SkillMountPathInput },
): Promise<DriftIgnoreReport> {
  const drift = await detectDrift(projectRoot, skillsSource, mountRules, opts);
  await markDriftIgnored(projectRoot, drift.driftHash);
  return { ignoredHash: drift.driftHash, ignoredSnapshot: drift };
}
