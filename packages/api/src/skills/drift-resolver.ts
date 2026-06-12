/**
 * Drift Resolver — F228 Three-Layer Model
 *
 * Applies the user's "sync" or "ignore" decision to a pre-computed DriftResult.
 * Uses syncProject as the unified reconciliation engine:
 *
 *   - action='sync': pre-deletes all conflict paths (override), then syncProject
 *     reconciles the entire project (mount new, remove stale).
 *
 *   - action='ignore': marks the current driftHash as ignored in projectState.
 */

import { lstat, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { clearDriftIgnored, markDriftIgnored } from '../config/mount/project-state-store.js';
import { buildSkillMountTargets } from '../utils/skill-mount.js';
import type { SkillMountPathInput } from '../utils/skill-mount-policy.js';
import type { DriftResult } from './drift-detector.js';
import { syncProject } from './skill-sync-engine.js';

// ────────── Types ──────────

export interface DriftSyncReport {
  mounted: string[];
  unmounted: string[];
  /** Conflict skills whose blockers were pre-deleted before sync. */
  overridden: string[];
  resolvedFrom: DriftResult;
}

export interface DriftIgnoreReport {
  ignoredHash: string;
  ignoredSnapshot: DriftResult;
}

// ────────── Sync Drift ──────────

export async function syncDrift(
  projectRoot: string,
  skillsSource: string,
  mountRules: MountRules,
  drift: DriftResult,
  opts?: {
    disabledSkills?: Iterable<string>;
    skillMountPaths?: SkillMountPathInput;
    cascadeDisabledSkills?: Iterable<string>;
  },
): Promise<DriftSyncReport> {
  // Pre-delete all conflict paths so syncProject sees them as 'missing'.
  // Use project-scoped targets only — standard providers resolve to project dir,
  // NOT HOME fallback, to avoid cross-project side-effects (P1-1 review fix).
  const overriddenSkills = new Set<string>();
  const resolveTargets = new Map<string, string[]>();
  for (const id of STANDARD_PROVIDER_IDS) {
    const rule = mountRules.providers[id];
    if (rule.enabled) resolveTargets.set(id, [join(projectRoot, rule.path)]);
  }
  for (const target of buildSkillMountTargets(projectRoot, homedir(), mountRules)) {
    if (target.kind === 'custom') resolveTargets.set(target.id, [...target.candidates]);
  }
  for (const conflict of drift.conflicts ?? []) {
    overriddenSkills.add(conflict.skill);
    const dirs = resolveTargets.get(conflict.provider);
    if (dirs) {
      for (const dir of dirs) {
        await rm(join(dir, conflict.skill), { recursive: true, force: true }).catch(() => {});
        try {
          const rootStat = await lstat(dir);
          if (rootStat.isSymbolicLink() || rootStat.isFile()) await rm(dir, { force: true });
        } catch {
          /* ENOENT — fine */
        }
      }
    }
  }

  // Clear drift-ignored state so future drifts trigger normally
  await clearDriftIgnored(projectRoot);

  // Reconcile the entire project via syncProject
  const disabledSet = new Set(opts?.disabledSkills ?? []);
  const cascadeDisabledSet = new Set(opts?.cascadeDisabledSkills ?? []);
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
    force: false,
  });

  const mountedSkills = new Set(syncResult.mounted.map((m) => m.skillName));
  const unmountedSkills = new Set(syncResult.unmounted.map((u) => u.skillName));

  return {
    mounted: [...mountedSkills].sort(),
    unmounted: [...unmountedSkills].sort(),
    overridden: [...overriddenSkills].sort(),
    resolvedFrom: drift,
  };
}

// ────────── Ignore Drift ──────────

export async function ignoreDrift(projectRoot: string, drift: DriftResult): Promise<DriftIgnoreReport> {
  await markDriftIgnored(projectRoot, drift.driftHash);
  return { ignoredHash: drift.driftHash, ignoredSnapshot: drift };
}
