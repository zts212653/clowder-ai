/** Config persistence after sync — extracted from skill-sync-engine for file-size. */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { resolveEffectiveSkillMountPaths } from '../config/governance/skill-sync.js';
import { removeCatCafeSkillCapabilities, updateSkillMountPaths } from '../config/governance/skills-state.js';

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
