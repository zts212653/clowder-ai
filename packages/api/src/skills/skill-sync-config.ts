/**
 * Skill Sync Config — capabilities.json write helpers for sync operations.
 *
 * Contains updateConfigAfterSync (used by syncProject) and the underlying
 * config mutation functions (updateSkillMountPaths, removeCatCafeSkillCapabilities,
 * readSkillsSyncState, writeSkillsSyncState).
 *
 * These were previously in skills-state.ts; moved here because their only
 * consumers are the sync engine and governance bootstrap.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { type MountRules, type SkillsSyncState, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { resolveEffectiveSkillMountPaths } from '../config/governance/skill-sync.js';

// ────────── Config read/write primitives ──────────

/** Read sync state from capabilities.json#skillsSync. */
export async function readSkillsSyncState(projectRoot: string): Promise<SkillsSyncState | null> {
  const config = await readCapabilitiesConfig(projectRoot);
  if (config?.skillsSync) {
    const s = config.skillsSync;
    if (
      typeof s.sourceRoot === 'string' &&
      typeof s.sourceManifestHash === 'string' &&
      typeof s.lastSyncedAt === 'string'
    ) {
      return s;
    }
  }
  return null;
}

/** Write sync state to capabilities.json#skillsSync. */
export async function writeSkillsSyncState(projectRoot: string, syncState: SkillsSyncState): Promise<void> {
  let config = await readCapabilitiesConfig(projectRoot);
  if (!config) {
    config = { version: 2, capabilities: [] };
  }
  if (config.version === 1) {
    config.version = 2;
  }
  config.skillsSync = syncState;
  await writeCapabilitiesConfig(projectRoot, config);
}

/**
 * Update mountPaths for specific skills in capabilities.json.
 * Sets mountPaths to the given mount point ids for each skill.
 */
export async function updateSkillMountPaths(
  projectRoot: string,
  skillNames: string[],
  mountPointIds: string[],
  opts?: { forceDisabled?: boolean; forceEnabled?: boolean },
): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const nameSet = new Set(skillNames);
  // F228: Only explicit force flags change enabled/globalEnabled.
  // Without force flags, only mountPaths is updated — project-scope toggles
  // should not leak into the global enabled state.
  const hasForce = opts?.forceDisabled === true || opts?.forceEnabled === true;
  const resolvedEnabled = opts?.forceDisabled === true ? false : opts?.forceEnabled === true ? true : undefined;
  const isCatCafeSkill = (cap: (typeof config.capabilities)[number]) =>
    cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId;
  const existingIds = new Set(config.capabilities.filter(isCatCafeSkill).map((c) => c.id));

  for (const cap of config.capabilities) {
    if (isCatCafeSkill(cap) && nameSet.has(cap.id)) {
      // F228: always write mountPaths — empty = no active mount points in project scope.
      cap.mountPaths = [...mountPointIds];
      // Force flags additionally write enabled/globalEnabled (global-scope toggles).
      // Without force, only mountPaths changes — project-scope toggles must not
      // leak into the global enabled state.
      if (hasForce && resolvedEnabled !== undefined) {
        cap.enabled = resolvedEnabled;
        cap.globalEnabled = resolvedEnabled;
      }
      nameSet.delete(cap.id);
    }
  }

  for (const skillName of nameSet) {
    if (!existingIds.has(skillName)) {
      config.capabilities.push({
        id: skillName,
        type: 'skill',
        source: 'cat-cafe',
        enabled: resolvedEnabled ?? true,
        globalEnabled: resolvedEnabled ?? true,
        mountPaths: [...mountPointIds],
      });
    }
  }

  await writeCapabilitiesConfig(projectRoot, config);
}

/**
 * Remove source-tree Cat Cafe skill capabilities that no longer exist.
 * Plugin-owned skill capabilities are intentionally preserved.
 */
export async function removeCatCafeSkillCapabilities(projectRoot: string, skillNames: string[]): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const nameSet = new Set(skillNames);
  const before = config.capabilities.length;
  config.capabilities = config.capabilities.filter(
    (cap) => !(cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && nameSet.has(cap.id)),
  );
  if (config.capabilities.length !== before) {
    await writeCapabilitiesConfig(projectRoot, config);
  }
}

// ────────── updateConfigAfterSync ──────────

export interface ConfigSyncCtx {
  enabledNames: string[];
  disabledNames: string[];
  removedNames: string[];
  mountPathsBySkill: ReadonlyMap<string, readonly string[]>;
  projectConfigMountPaths: ReadonlyMap<string, readonly string[]>;
  explicitMountPathSkills: ReadonlySet<string>;
  activeTargetIds: string[];
  cascadeDisabledInThisSync: Set<string>;
  prevCascadeDisabled: Set<string>;
  configDisabledSet: Set<string>;
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  mountRules: MountRules;
  pruneMountPaths?: boolean;
  /** When true, inherited-only global mount paths are skipped to preserve cascade. */
  preserveGlobalCascade?: boolean;
  /** Mount point IDs that were just enabled (absent in previous rules, present now).
   *  When set, active skills (mountPaths.length > 0) get these IDs supplemented. */
  newlyEnabledMountPointIds?: string[];
}

export async function updateConfigAfterSync(projectRoot: string, ctx: ConfigSyncCtx): Promise<void> {
  if (ctx.enabledNames.length > 0) {
    const grouped = new Map<string, { skillNames: string[]; mountPointIds: string[] }>();
    const noPolicySkills: string[] = [];
    const activeSet = new Set(ctx.activeTargetIds);
    for (const name of ctx.enabledNames) {
      const declared = resolveEffectiveSkillMountPaths(
        ctx.mountPathsBySkill.get(name),
        ctx.globalMountPathsBySkill?.get(name),
      );
      if (declared) {
        // Exclude previous cascade-disabled entries from "local policy" — those empty
        // mountPaths rows are cascade-origin, not user-set. Treating them as local would
        // freeze inherited paths on re-enable, blocking future global cascade changes.
        const hasLocalPolicy =
          (ctx.projectConfigMountPaths.has(name) && !ctx.prevCascadeDisabled.has(name)) ||
          ctx.explicitMountPathSkills.has(name);
        // Skip writing inherited-only mount paths to project config — preserve global cascade.
        // Only active in drift-resolve context (preserveGlobalCascade=true) where global
        // policy changes should propagate without freezing. Explicit sync operations
        // (sync/sync-skill) write mount paths to establish local baseline.
        if (ctx.preserveGlobalCascade && !hasLocalPolicy && !ctx.mountPathsBySkill.has(name)) continue;
        const shouldPrune = ctx.pruneMountPaths || !hasLocalPolicy;
        const mountPointIds = shouldPrune ? declared.filter((id) => activeSet.has(id)) : [...declared];
        // F228: When a mount point is newly enabled, supplement active skills
        // (those with non-empty mountPaths) so they appear in the new mount point.
        // Skills with empty mountPaths (project-disabled) are left alone.
        if (ctx.newlyEnabledMountPointIds?.length && mountPointIds.length > 0) {
          for (const id of ctx.newlyEnabledMountPointIds) {
            if (!mountPointIds.includes(id)) mountPointIds.push(id);
          }
        }
        const key = JSON.stringify(mountPointIds);
        const g = grouped.get(key) ?? { skillNames: [], mountPointIds };
        g.skillNames.push(name);
        grouped.set(key, g);
      } else noPolicySkills.push(name);
    }
    for (const { skillNames, mountPointIds } of grouped.values())
      await updateSkillMountPaths(projectRoot, skillNames, mountPointIds);
    if (noPolicySkills.length > 0) {
      const reEnabled = new Set(
        noPolicySkills.filter(
          (n) =>
            ctx.prevCascadeDisabled.has(n) && ctx.configDisabledSet.has(n) && !ctx.cascadeDisabledInThisSync.has(n),
        ),
      );
      if (reEnabled.size > 0)
        await updateSkillMountPaths(projectRoot, [...reEnabled], ctx.activeTargetIds, { forceEnabled: true });
      const rest = noPolicySkills.filter((n) => !reEnabled.has(n));
      if (rest.length > 0) await updateSkillMountPaths(projectRoot, rest, ctx.activeTargetIds);
    }
  }
  if (ctx.removedNames.length > 0) {
    const disabledDirs = STANDARD_MOUNT_POINT_IDS.filter((id) => !ctx.mountRules.mountPoints[id].enabled).map((id) =>
      join(projectRoot, ctx.mountRules.mountPoints[id].path),
    );
    const deferred = new Set<string>();
    for (const dir of disabledDirs)
      for (const n of ctx.removedNames) {
        try {
          if ((await lstat(join(dir, n))).isSymbolicLink()) deferred.add(n);
        } catch {
          /* ignore */
        }
      }
    const deferredList = ctx.removedNames.filter((n) => deferred.has(n));
    const fullList = ctx.removedNames.filter((n) => !deferred.has(n));
    if (deferredList.length > 0) await updateSkillMountPaths(projectRoot, deferredList, [], { forceDisabled: true });
    if (fullList.length > 0) await removeCatCafeSkillCapabilities(projectRoot, fullList);
  }
  if (ctx.disabledNames.length > 0) {
    const localMountPathDisabled: string[] = [];
    const forcedDisabled: string[] = [];
    for (const name of ctx.disabledNames) {
      const hasProjectMountPolicy = ctx.projectConfigMountPaths.has(name) || ctx.explicitMountPathSkills.has(name);
      if (hasProjectMountPolicy && !ctx.cascadeDisabledInThisSync.has(name)) localMountPathDisabled.push(name);
      else forcedDisabled.push(name);
    }

    if (localMountPathDisabled.length > 0) await updateSkillMountPaths(projectRoot, localMountPathDisabled, []);
    if (forcedDisabled.length > 0)
      await updateSkillMountPaths(projectRoot, forcedDisabled, [], { forceDisabled: true });
  }
}
