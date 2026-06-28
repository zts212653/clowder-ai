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
 * Remove source-tree Clowder AI skill capabilities that no longer exist.
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
  globalMountPathsBySkill?: ReadonlyMap<string, readonly string[]>;
  mountRules: MountRules;
  pruneMountPaths?: boolean;
  /** When true, inherited-only global mount paths are skipped to preserve cascade. */
  preserveGlobalCascade?: boolean;
  /** Skill names that already exist in the project config. Used with preserveGlobalCascade
   *  to distinguish existing skills from newly discovered ones during drift-resolve sync;
   *  new skills still need a config entry without mountPaths to keep global cascade live. */
  existingProjectSkills?: ReadonlySet<string>;
  /** Mount point IDs that were just enabled (absent in previous rules, present now).
   *  When set, active skills (mountPaths.length > 0) get these IDs supplemented. */
  newlyEnabledMountPointIds?: string[];
}

export async function updateConfigAfterSync(projectRoot: string, ctx: ConfigSyncCtx): Promise<void> {
  // New skills discovered during drift-resolve that inherit only global mount paths.
  // They need a config entry (so drift-check stops reporting configNew) but must NOT
  // have project-local mountPaths written (that would freeze the global cascade).
  const cascadeNewSkills: string[] = [];

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
        const hasLocalPolicy = ctx.projectConfigMountPaths.has(name) || ctx.explicitMountPathSkills.has(name);
        // Skip writing inherited-only mount paths to project config — preserve global cascade.
        // Only active in drift-resolve context (preserveGlobalCascade=true) where global
        // policy changes should propagate without freezing. Explicit sync operations
        // (sync/sync-skill) write mount paths to establish local baseline.
        if (ctx.preserveGlobalCascade && !hasLocalPolicy && !ctx.mountPathsBySkill.has(name)) {
          // New skills still need a config entry so drift-check stops reporting configNew.
          // Collect them for registration WITHOUT mountPaths below.
          if (ctx.existingProjectSkills && !ctx.existingProjectSkills.has(name)) {
            cascadeNewSkills.push(name);
          }
          continue;
        }
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
    // F228: no-policy skills (no declared mountPaths) get all active mount points.
    if (noPolicySkills.length > 0) {
      await updateSkillMountPaths(projectRoot, noPolicySkills, ctx.activeTargetIds);
    }
  }
  // Register new inherited-only skills in config WITHOUT mountPaths.
  // This creates a managed capability entry (drift-check stops reporting configNew)
  // while preserving global mount path cascade (no project-local mountPaths written,
  // so resolveEffectiveSkillMountPaths falls through to global policy).
  if (cascadeNewSkills.length > 0) {
    const config = await readCapabilitiesConfig(projectRoot);
    if (config) {
      const existingIds = new Set(
        config.capabilities
          .filter((c) => c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId)
          .map((c) => c.id),
      );
      let changed = false;
      for (const name of cascadeNewSkills) {
        if (!existingIds.has(name)) {
          config.capabilities.push({ id: name, type: 'skill', source: 'cat-cafe', enabled: true, globalEnabled: true });
          changed = true;
        }
      }
      if (changed) await writeCapabilitiesConfig(projectRoot, config);
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
  // F228 scenario 4: disabled skills get mountPaths:[]. Per feat doc, only mountPaths
  // changes — enabled/globalEnabled are not modified by project-scope operations.
  // forceDisabled is only used for skills not yet in config (new entries need enabled:false).
  if (ctx.disabledNames.length > 0) {
    const hasConfig: string[] = [];
    const noConfig: string[] = [];
    for (const name of ctx.disabledNames) {
      if (ctx.projectConfigMountPaths.has(name) || ctx.explicitMountPathSkills.has(name)) hasConfig.push(name);
      else noConfig.push(name);
    }
    if (hasConfig.length > 0) await updateSkillMountPaths(projectRoot, hasConfig, []);
    if (noConfig.length > 0) await updateSkillMountPaths(projectRoot, noConfig, [], { forceDisabled: true });
  }
}
