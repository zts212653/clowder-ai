/**
 * Skill Sync All — F228 redesign
 *
 * `syncAll` cascades global skill state to all governance-registered projects.
 * For each external project, reads its local config and calls `syncProject`
 * with cascade-disabled skills from global state.
 */

import type { MountRules } from '@cat-cafe/shared';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { listAllProjectPaths } from '../config/governance/list-all-projects.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
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

  // #712: Unified project enumeration (governance + nested thread-derived).
  // listAllProjectPaths already excludes catCafeRoot and validates paths.
  let projectPaths: string[];
  try {
    projectPaths = await listAllProjectPaths(catCafeRoot);
  } catch (err) {
    const msg = `Failed to enumerate projects: ${(err as Error).message}`;
    console.warn(`[F228] ${msg}`);
    warnings.push(msg);
    return { perProject, warnings };
  }

  // Sync each external project (main is handled by the caller)
  for (const projectPath of projectPaths) {
    try {
      const result = await withCapabilityLock(projectPath, async () => {
        const projectMountRules = await readMountRules(projectPath, catCafeRoot);
        const projectConfig = await readCapabilitiesConfig(projectPath);
        const projectManagedCaps =
          projectConfig?.capabilities.filter(
            (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId,
          ) ?? [];

        // F228 scenarios 6/7: global cascade is unconditional.
        // disabledSkills = globalDisabledSkills — global state is authoritative.
        // Per feat doc: "全局禁用 skill → 逐项目执行场景 4" (unconditional),
        // "全局启用 skill → 逐项目执行场景 5" (unconditional).

        // F228: per-mount-point cascade — if a mount point was removed globally
        // for a skill, remove it from the project's mountPaths too. Without this,
        // the project's own mountPaths take precedence and block the cascade.
        //
        // P1-1 fix: When a skill is globally enabled (NOT in globalDisabledSkills)
        // but has empty mountPaths in the project config (from a previous global
        // disable), do NOT include it as explicit policy. This allows syncProject's
        // scenario 7 logic to clear the stale empty mountPaths and re-enable the
        // skill with all active mount points.
        const projectMountPathsBySkill = new Map(
          projectManagedCaps.flatMap((cap) => {
            if (!Array.isArray(cap.mountPaths)) return [];
            const globalPaths = globalMountPathsBySkill.get(cap.id);
            // Constrain: keep only mount points that exist in the global list.
            // Global removal cascades; global addition is handled by newlyEnabled logic.
            const paths = globalPaths ? cap.mountPaths.filter((p) => globalPaths.includes(p)) : cap.mountPaths;
            // Globally enabled + empty project paths = stale disable state.
            // Omit from explicit policy so syncProject scenario 7 can re-enable.
            if (paths.length === 0 && !globalDisabledSkills.has(cap.id)) return [];
            return [[cap.id, paths] as const];
          }),
        );

        return syncProject(projectPath, skillsSource, {
          mountRules: projectMountRules,
          previousMountRules: opts.previousMountRules,
          pruneMountPaths: !!opts.previousMountRules,
          disabledSkills: globalDisabledSkills,
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
