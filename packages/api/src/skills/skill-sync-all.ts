/**
 * Skill Sync All — F228 redesign
 *
 * `syncAll` cascades global skill state to all governance-registered projects.
 * For each external project, reads its local config and calls `syncProject`
 * with cascade-disabled skills from global state.
 */

import type { MountRules } from '@cat-cafe/shared';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { type SyncProjectResult, syncProject } from './skill-sync-engine.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncAllResult {
  perProject: Map<string, SyncProjectResult>;
  warnings: string[];
}

export interface SyncAllOptions {
  mountRules: MountRules;
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
export async function syncAll(catCafeRoot: string, skillsSource: string, opts: SyncAllOptions): Promise<SyncAllResult> {
  const { force = false } = opts;
  const perProject = new Map<string, SyncProjectResult>();
  const warnings: string[] = [];

  // Read main project config for global state
  const mainConfig = await readCapabilitiesConfig(catCafeRoot);
  const mainManagedCaps =
    mainConfig?.capabilities.filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId) ?? [];

  const globalDisabledSkills = new Set(mainManagedCaps.filter((cap) => !cap.enabled).map((cap) => cap.id));
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

    try {
      const projectMountRules = await readMountRules(projectPath, catCafeRoot);
      const projectConfig = await readCapabilitiesConfig(projectPath);
      const projectManagedCaps =
        projectConfig?.capabilities.filter(
          (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId,
        ) ?? [];

      const result = await syncProject(projectPath, skillsSource, {
        mountRules: projectMountRules,
        disabledSkills: new Set(projectManagedCaps.filter((cap) => !cap.enabled).map((cap) => cap.id)),
        cascadeDisabledSkills: globalDisabledSkills,
        mountPathsBySkill: new Map(
          projectManagedCaps.flatMap((cap) =>
            Array.isArray(cap.mountPaths) ? [[cap.id, cap.mountPaths] as const] : [],
          ),
        ),
        globalMountPathsBySkill,
        force,
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
