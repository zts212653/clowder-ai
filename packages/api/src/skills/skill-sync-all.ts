/**
 * Skill Sync All — F228 redesign
 *
 * `syncAll` cascades global skill state to all governance-registered projects.
 * For each external project, reads its local config and calls `syncProject`
 * with cascade-disabled skills from global state.
 */

import { stat } from 'node:fs/promises';
import type { MountRules } from '@cat-cafe/shared';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { readSkillsSyncState } from './skill-sync-config.js';
import { type SyncProjectResult, syncProject } from './skill-sync-engine.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncAllResult {
  perProject: Map<string, SyncProjectResult>;
  /** Real propagation failures (sync errors). Caller may surface as failure. */
  warnings: string[];
}

export interface SyncAllOptions {
  mountRules: MountRules;
  /** Previous global mount rules — passed to syncProject for cleanup of old dirs. */
  previousMountRules?: MountRules;
  /** Skills disabled in global (main project) config. */
  globalDisabledSkills?: ReadonlySet<string>;
  /** Per-skill mount path policy from global config. */
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  /** false (default): conflict → skip+record. true: conflict → override. */
  force?: boolean;
}

// ── syncAll ──────────────────────────────────────────────────────────────────

/**
 * Cascade global skill state to all registered projects.
 *
 * 1. Read main project config for global disabled set + mount path policy
 * 2. List all governance-registered projects
 * 3. For each external project: read local config → syncProject with cascade
 * 4. Aggregate results + warnings (per-project errors don't abort the loop)
 */
export function syncAll(catCafeRoot: string, skillsSource: string, opts: SyncAllOptions): Promise<SyncAllResult> {
  return withCapabilityLock(catCafeRoot, () => syncAllUnlocked(catCafeRoot, skillsSource, opts));
}

async function syncAllUnlocked(
  catCafeRoot: string,
  skillsSource: string,
  opts: SyncAllOptions,
): Promise<SyncAllResult> {
  const { force = false } = opts;
  const perProject = new Map<string, SyncProjectResult>();
  const warnings: string[] = [];

  // Read main project config for global state
  const mainConfig = await readCapabilitiesConfig(catCafeRoot);
  const mainManagedCaps =
    mainConfig?.capabilities.filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId) ?? [];

  const globalDisabledSkills = new Set(
    mainManagedCaps.filter((cap) => !(cap.globalEnabled ?? cap.enabled)).map((cap) => cap.id),
  );
  for (const name of opts.globalDisabledSkills ?? []) globalDisabledSkills.add(name);

  const globalMountPathsBySkill = new Map(
    mainManagedCaps.flatMap((cap) => (Array.isArray(cap.mountPaths) ? [[cap.id, cap.mountPaths] as const] : [])),
  );
  for (const [name, paths] of opts.globalMountPathsBySkill ?? []) {
    if (!globalMountPathsBySkill.has(name)) globalMountPathsBySkill.set(name, [...paths]);
  }

  // List registered projects via GovernanceRegistry
  let projectPaths: string[];
  try {
    const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
    const entries = await new GovernanceRegistry(catCafeRoot).listAll();
    projectPaths = entries.map((e) => e.projectPath);
  } catch (err) {
    const msg = `Failed to read governance registry: ${(err as Error).message}`;
    console.warn(`[F228] ${msg}`);
    warnings.push(msg);
    return { perProject, warnings };
  }

  // Sync each external project (main is handled by the caller)
  for (const projectPath of projectPaths) {
    if (projectPath === catCafeRoot) continue;

    // Stale registry entries (deleted temp-dirs, old worktrees) are silently
    // skipped — they are NOT propagation failures. The root cause is a
    // pre-existing test bug where project-setup tests register temp dirs in
    // the real governance-registry without cleaning up (tracked separately).
    try {
      const pathStat = await stat(projectPath);
      if (!pathStat.isDirectory()) {
        console.warn(`[F228] skipping stale registry entry (not a directory): ${projectPath}`);
        continue;
      }
    } catch {
      console.warn(`[F228] skipping stale registry entry (path missing): ${projectPath}`);
      continue;
    }

    try {
      const result = await withCapabilityLock(projectPath, async () => {
        const projectMountRules = await readMountRules(projectPath, catCafeRoot);
        const projectConfig = await readCapabilitiesConfig(projectPath);
        const projectManagedCaps =
          projectConfig?.capabilities.filter(
            (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId,
          ) ?? [];

        // Exclude skills that were cascade-disabled (no local opinion) from disabledSkills.
        // Without this filter, a globally re-enabled skill stays disabled because
        // syncProject seeds disabledSet from opts.disabledSkills before consulting
        // prevCascadeDisabled, blocking the re-enable path.
        const prevCascade = new Set((await readSkillsSyncState(projectPath))?.cascadeDisabledSkills ?? []);
        const locallyDisabledSkills = new Set(
          projectManagedCaps
            .filter(
              (cap) =>
                (Array.isArray(cap.mountPaths) ? cap.mountPaths.length === 0 : !(cap.globalEnabled ?? cap.enabled)) &&
                !prevCascade.has(cap.id),
            )
            .map((cap) => cap.id),
        );

        // F228: per-mount-point cascade — if a mount point was removed globally
        // for a skill, remove it from the project's mountPaths too. Without this,
        // the project's own mountPaths take precedence and block the cascade.
        const projectMountPathsBySkill = new Map(
          projectManagedCaps.flatMap((cap) => {
            if (!Array.isArray(cap.mountPaths)) return [];
            const globalPaths = globalMountPathsBySkill.get(cap.id);
            // Constrain: keep only mount points that exist in the global list.
            // Global removal cascades; global addition is handled by newlyEnabled logic.
            const paths = globalPaths ? cap.mountPaths.filter((p) => globalPaths.includes(p)) : cap.mountPaths;
            return [[cap.id, paths] as const];
          }),
        );

        return syncProject(projectPath, skillsSource, {
          mountRules: projectMountRules,
          previousMountRules: opts.previousMountRules,
          pruneMountPaths: !!opts.previousMountRules,
          disabledSkills: locallyDisabledSkills,
          cascadeDisabledSkills: globalDisabledSkills,
          mountPathsBySkill: projectMountPathsBySkill,
          globalMountPathsBySkill,
          force,
        });
      });
      perProject.set(projectPath, result);
    } catch (err) {
      const msg = `${projectPath}: ${(err as Error).message}`;
      console.warn(`[F228] ${msg}`);
      warnings.push(msg);
    }
  }

  return { perProject, warnings };
}
