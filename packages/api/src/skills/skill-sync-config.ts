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

import { type MountRules, type SkillsSyncState, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
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
 * Sets mountPaths to the given provider names for each skill.
 */
export async function updateSkillMountPaths(
  projectRoot: string,
  skillNames: string[],
  providerNames: string[],
  opts?: { forceDisabled?: boolean; forceEnabled?: boolean },
): Promise<void> {
  if (skillNames.length === 0) return;
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return;

  const nameSet = new Set(skillNames);
  const resolvedEnabled =
    opts?.forceDisabled === true ? false : opts?.forceEnabled === true ? true : providerNames.length > 0 || undefined;
  const isCatCafeSkill = (cap: (typeof config.capabilities)[number]) =>
    cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId;
  const existingIds = new Set(config.capabilities.filter(isCatCafeSkill).map((c) => c.id));

  for (const cap of config.capabilities) {
    if (isCatCafeSkill(cap) && nameSet.has(cap.id)) {
      if (resolvedEnabled !== undefined) {
        cap.enabled = resolvedEnabled;
        cap.mountPaths = [...providerNames];
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
        mountPaths: [...providerNames],
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
}

export async function updateConfigAfterSync(projectRoot: string, ctx: ConfigSyncCtx): Promise<void> {
  if (ctx.enabledNames.length > 0) {
    const grouped = new Map<string, { skillNames: string[]; providerNames: string[] }>();
    const noPolicySkills: string[] = [];
    const activeSet = new Set(ctx.activeTargetIds);
    for (const name of ctx.enabledNames) {
      const declared = resolveEffectiveSkillMountPaths(
        ctx.mountPathsBySkill.get(name),
        ctx.globalMountPathsBySkill?.get(name),
      );
      if (declared) {
        const hasLocalPolicy = ctx.projectConfigMountPaths.has(name) || ctx.explicitMountPathSkills.has(name);
        const shouldPrune = ctx.pruneMountPaths || !hasLocalPolicy;
        const providerNames = shouldPrune ? declared.filter((id) => activeSet.has(id)) : [...declared];
        const key = JSON.stringify(providerNames);
        const g = grouped.get(key) ?? { skillNames: [], providerNames };
        g.skillNames.push(name);
        grouped.set(key, g);
      } else noPolicySkills.push(name);
    }
    for (const { skillNames, providerNames } of grouped.values())
      await updateSkillMountPaths(projectRoot, skillNames, providerNames);
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
    const disabledDirs = STANDARD_PROVIDER_IDS.filter((id) => !ctx.mountRules.providers[id].enabled).map((id) =>
      join(projectRoot, ctx.mountRules.providers[id].path),
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
  if (ctx.disabledNames.length > 0)
    await updateSkillMountPaths(projectRoot, ctx.disabledNames, [], { forceDisabled: true });
}
