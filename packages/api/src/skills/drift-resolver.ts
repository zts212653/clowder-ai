/**
 * Drift Resolver — F228 Phase 2B
 *
 * Applies the user's "sync" or "ignore" decision to the current DriftResult:
 *
 *   - action='sync': mounts newSkills, unmounts stale, processes each
 *     conflict according to conflictChoices ('override' → replace local
 *     path with managed symlink; 'skip' → leave user's version). Clears
 *     the projectState.ignoredDriftHash so future drifts trigger again.
 *
 *   - action='ignore': marks the current driftHash as ignored in
 *     projectState. detectDrift returns isIgnored=true until source or
 *     policy changes the hash.
 */

import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import {
  computeSourceManifestHash,
  listSourceSkillNames,
  removeCatCafeSkillCapabilities,
  updateSkillMountPaths,
  writeSkillsSyncState,
} from '../config/governance/skills-state.js';
import { clearDriftIgnored } from '../config/mount/project-state-store.js';
import { buildProjectSkillMountDirs, isManagedDirectoryLevelSkillsSymlink } from '../utils/skill-mount.js';
import {
  normalizeSkillMountPathPolicy,
  type SkillMountPathInput,
  skillAllowsMountProvider,
  skillMountProviderIds,
} from '../utils/skill-mount-policy.js';
import {
  convertManagedDirectoryLevelSkillMountsForPolicy,
  filterRulesToProvider,
  mountSkillForProject,
  unmountSkillForProject,
} from '../utils/skill-symlink-writer.js';
import { type DriftResult, detectDrift } from './drift-detector.js';
import {
  type ConflictChoice,
  classifyProviderRootForOverride,
  type DriftSyncReport,
  disablePolicyDisabledCapabilities,
  discardMutablePath,
  type PathSnapshot,
  restoreMutablePath,
  snapshotMutablePath,
  snapshotSymlinkOnly,
} from './drift-helpers.js';

export type { ConflictChoice, DriftIgnoreReport, DriftSyncReport } from './drift-helpers.js';

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

  const mounted: string[] = [];
  const unmounted: string[] = [];
  const overridden: string[] = [];
  const skipped: string[] = [];
  const snapshots: Array<{ path: string; snapshot: PathSnapshot }> = [];
  const disabledSet = new Set(opts?.disabledSkills ?? []);
  const skillMountPathPolicy = normalizeSkillMountPathPolicy(opts?.skillMountPaths);
  const policyStaleSkills = new Set<string>();
  const removableSkillDirs = buildProjectSkillMountDirs(projectRoot, homedir(), mountRules, {
    includeDisabledStandardProviders: true,
  });
  let sourceSkillNamesForLegacyConversion: string[] | undefined;
  let sourceSkillNamesForStale: Set<string> | undefined;

  async function capture(path: string, opts?: { symlinkOnly?: boolean }): Promise<void> {
    const snapshot = opts?.symlinkOnly ? await snapshotSymlinkOnly(path) : await snapshotMutablePath(path);
    if (snapshot) snapshots.push({ path, snapshot });
  }

  async function captureSkillPaths(
    skillName: string,
    opts?: { includeDisabled?: boolean; symlinkOnly?: boolean },
  ): Promise<void> {
    for (const skillsDir of opts?.includeDisabled ? removableSkillDirs : activeSkillDirsForSkill(skillName)) {
      if (!opts?.symlinkOnly && (await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource))) continue;
      await capture(join(skillsDir, skillName), { symlinkOnly: opts?.symlinkOnly });
    }
  }

  function activeProviderIdsForSkill(skillName: string): string[] {
    const declared = skillMountProviderIds(skillMountPathPolicy, skillName);
    const enabledProviderNames = STANDARD_PROVIDER_IDS.filter((id) => mountRules.providers[id].enabled);
    const customAliases = (mountRules.customPaths ?? []).map((cp) => cp.alias);
    const allMountTargets = [...enabledProviderNames, ...customAliases];
    if (!declared) return allMountTargets;
    return allMountTargets.filter((providerId) => declared.has(providerId));
  }

  /** F228: Return declared desired providers (NOT filtered by active).
   *  Used for persistence — desired policy must survive temporary provider unavailability. */
  function declaredProviderIdsForSkill(skillName: string): string[] | null {
    const declared = skillMountProviderIds(skillMountPathPolicy, skillName);
    return declared ? [...declared] : null;
  }

  function activeMountProviderIds(): string[] {
    const enabledProviderNames = STANDARD_PROVIDER_IDS.filter((id) => mountRules.providers[id].enabled);
    const customAliases = (mountRules.customPaths ?? []).map((cp) => cp.alias);
    return [...enabledProviderNames, ...customAliases];
  }

  function policyStaleProviderIdsForSkill(skillName: string): string[] {
    const declared = skillMountProviderIds(skillMountPathPolicy, skillName);
    if (!declared) return [];
    return activeMountProviderIds().filter((providerId) => !declared.has(providerId));
  }

  function rulesForSkill(skillName: string): MountRules[] {
    const declared = skillMountProviderIds(skillMountPathPolicy, skillName);
    if (!declared) return [mountRules];
    return [...declared].map((providerId) => filterRulesToProvider(mountRules, providerId));
  }

  function activeSkillDirsForSkill(skillName: string): string[] {
    return [
      ...new Set(
        rulesForSkill(skillName).flatMap((rules) => buildProjectSkillMountDirs(projectRoot, homedir(), rules)),
      ),
    ];
  }

  async function mountSkillForPolicy(skillName: string): Promise<void> {
    for (const rules of rulesForSkill(skillName)) {
      await mountSkillForProject(projectRoot, skillName, skillsSource, rules);
    }
  }

  async function expectedSkillNamesForLegacyMounts(providerId: string): Promise<string[]> {
    sourceSkillNamesForLegacyConversion ??= await listSourceSkillNames(skillsSource);
    return sourceSkillNamesForLegacyConversion.filter(
      (name) => !disabledSet.has(name) && skillAllowsMountProvider(skillMountPathPolicy, name, providerId),
    );
  }

  async function sourceSkillNameSetForStale(): Promise<Set<string>> {
    sourceSkillNamesForStale ??= new Set(await listSourceSkillNames(skillsSource));
    return sourceSkillNamesForStale;
  }

  async function convertLegacyDirectoryMountsForActiveProviders(): Promise<void> {
    await convertLegacyDirectoryMountsForProviders(activeMountProviderIds());
  }

  async function convertLegacyDirectoryMountsForProviders(providerIds: readonly string[]): Promise<void> {
    await convertManagedDirectoryLevelSkillMountsForPolicy(
      projectRoot,
      skillsSource,
      mountRules,
      providerIds,
      expectedSkillNamesForLegacyMounts,
      { beforeConvert: capture },
    );
  }

  async function captureSkillPathsForProviders(skillName: string, providerIds: readonly string[]): Promise<void> {
    for (const providerId of providerIds) {
      const rules = filterRulesToProvider(mountRules, providerId);
      for (const skillsDir of buildProjectSkillMountDirs(projectRoot, homedir(), rules)) {
        await capture(join(skillsDir, skillName), { symlinkOnly: true });
      }
    }
  }

  async function unmountSkillForProviders(skillName: string, providerIds: readonly string[]): Promise<void> {
    for (const providerId of providerIds) {
      await unmountSkillForProject(
        projectRoot,
        skillName,
        filterRulesToProvider(mountRules, providerId),
        skillsSource,
        {
          enabledOnly: true,
        },
      );
    }
  }

  try {
    // 1) Mount newSkills (no blockers in the way)
    for (const skillName of drift.newSkills) {
      await captureSkillPaths(skillName);
      await mountSkillForPolicy(skillName);
      mounted.push(skillName);
    }

    // 2) Handle conflicts per user choice — keyed by skill+provider so users
    //    can decide per-provider. 'override' deletes the local path and
    //    re-mounts; 'skip' leaves the user's version for that provider.
    const overriddenSkills = new Set<string>();
    const conflictProvidersBySkill = new Map<string, Set<string>>();
    for (const c of drift.conflicts) {
      if (!conflictProvidersBySkill.has(c.skill)) conflictProvidersBySkill.set(c.skill, new Set());
      conflictProvidersBySkill.get(c.skill)!.add(c.provider);
    }
    for (const conflict of drift.conflicts) {
      const conflictKey = `${conflict.skill}:${conflict.provider}`;
      const choice: ConflictChoice = conflictChoices[conflictKey] ?? 'skip';
      if (choice === 'override') {
        // Remove the blocking path only for the specific provider.
        const providerMountDirs = buildProjectSkillMountDirs(
          projectRoot,
          homedir(),
          filterRulesToProvider(mountRules, conflict.provider),
        );
        for (const skillsDir of providerMountDirs) {
          const rootState = await classifyProviderRootForOverride(skillsDir, skillsSource);
          if (rootState === 'managed-directory') continue;
          if (rootState === 'invalid-symlink') {
            await capture(skillsDir);
            await rm(skillsDir, { force: true });
            continue;
          }
          if (rootState === 'blocking-root') {
            await capture(skillsDir);
            await rm(skillsDir, { recursive: true, force: true });
            continue;
          }
          const blockingPath = join(skillsDir, conflict.skill);
          await capture(blockingPath);
          await rm(blockingPath, { recursive: true, force: true });
        }
        // Mount into the specific overridden provider.
        await mountSkillForProject(
          projectRoot,
          conflict.skill,
          skillsSource,
          filterRulesToProvider(mountRules, conflict.provider),
        );
        overriddenSkills.add(conflict.skill);
      }
    }
    // For overridden skills, also mount into non-conflicting providers.
    for (const skillName of overriddenSkills) {
      const conflictProviders = conflictProvidersBySkill.get(skillName) ?? new Set();
      for (const providerId of activeProviderIdsForSkill(skillName)) {
        if (!conflictProviders.has(providerId)) {
          await mountSkillForProject(
            projectRoot,
            skillName,
            skillsSource,
            filterRulesToProvider(mountRules, providerId),
          );
        }
      }
      if (!mounted.includes(skillName)) mounted.push(skillName);
      overridden.push(skillName);
    }
    // For skipped-conflict skills, still mount non-conflicting providers
    // that are merely missing (the detector suppresses newSkills when any
    // provider conflicts, so non-conflicting missing mounts would otherwise
    // never converge).
    for (const skillName of conflictProvidersBySkill.keys()) {
      if (overriddenSkills.has(skillName)) continue;
      const conflictProviders = conflictProvidersBySkill.get(skillName) ?? new Set();
      for (const providerId of activeProviderIdsForSkill(skillName)) {
        if (!conflictProviders.has(providerId)) {
          await mountSkillForProject(
            projectRoot,
            skillName,
            skillsSource,
            filterRulesToProvider(mountRules, providerId),
          );
        }
      }
      skipped.push(skillName);
    }

    // 3) Unmount stale symlinks (source-removed or now-disabled skills)
    for (const skillName of drift.stale) {
      const isSourcePresent = (await sourceSkillNameSetForStale()).has(skillName);
      const policyStaleProviderIds =
        isSourcePresent && !disabledSet.has(skillName) ? policyStaleProviderIdsForSkill(skillName) : [];
      if (policyStaleProviderIds.length > 0) {
        await convertLegacyDirectoryMountsForProviders(policyStaleProviderIds);
        await captureSkillPathsForProviders(skillName, policyStaleProviderIds);
        await unmountSkillForProviders(skillName, policyStaleProviderIds);
        policyStaleSkills.add(skillName);
        unmounted.push(skillName);
        continue;
      }
      if (disabledSet.has(skillName)) {
        await convertLegacyDirectoryMountsForActiveProviders();
      }
      await captureSkillPaths(skillName, { includeDisabled: true, symlinkOnly: true });
      await unmountSkillForProject(projectRoot, skillName, mountRules, skillsSource);
      unmounted.push(skillName);
    }

    // 4) After a sync attempt, the ignore state is moot — clear it so future
    //    drifts (with the same or new hash) trigger normally.
    await clearDriftIgnored(projectRoot);

    // 5) Update capabilities.json#skillsSync so checkStaleness() sees the new
    //    manifest hash — without this, the banner stays red after sync.
    //    Also update mountPaths for mounted/unmounted skills.
    const newHash = await computeSourceManifestHash(skillsSource);
    // F228: Preserve cascade tracking from merged policy so a subsequent
    // syncSkills() can correctly re-enable globally re-enabled skills.
    const cascadeDisabled = [...new Set(opts?.cascadeDisabledSkills ?? [])].sort();
    await writeSkillsSyncState(projectRoot, {
      sourceRoot: relative(projectRoot, skillsSource),
      sourceManifestHash: newHash,
      lastSyncedAt: new Date().toISOString(),
      ...(cascadeDisabled.length > 0 ? { cascadeDisabledSkills: cascadeDisabled } : {}),
    });

    // F228: mountPaths = target mount policy. Persist the DECLARED policy
    // (full set from skillMountPaths), not the active intersection. Disabled
    // providers stay in mountPaths so restoreNewlyEnabledMountPoints() can
    // restore them on re-enable without user intervention.
    const mountedAndPolicyStale = [...new Set([...mounted, ...policyStaleSkills])];
    const groupedByDeclared = new Map<string, { skillNames: string[]; providerNames: string[] }>();
    const noPolicySkills: string[] = [];
    for (const skillName of mountedAndPolicyStale) {
      const declared = declaredProviderIdsForSkill(skillName);
      if (declared) {
        const key = JSON.stringify(declared);
        const group = groupedByDeclared.get(key) ?? { skillNames: [], providerNames: declared };
        group.skillNames.push(skillName);
        groupedByDeclared.set(key, group);
      } else {
        noPolicySkills.push(skillName);
      }
    }
    for (const { skillNames, providerNames } of groupedByDeclared.values()) {
      await updateSkillMountPaths(projectRoot, skillNames, providerNames);
    }
    if (noPolicySkills.length > 0) {
      // No declared policy — write all active mount targets as default
      const allActive = activeMountProviderIds();
      await updateSkillMountPaths(projectRoot, noPolicySkills, allActive);
    }
    const fullyUnmounted = unmounted.filter((skillName) => !policyStaleSkills.has(skillName));
    if (fullyUnmounted.length > 0) {
      const sourceNames = await sourceSkillNameSetForStale();
      const sourceRemoved = fullyUnmounted.filter((skillName) => !sourceNames.has(skillName));
      const sourcePresent = fullyUnmounted.filter((skillName) => sourceNames.has(skillName));
      await updateSkillMountPaths(projectRoot, sourcePresent, [], { forceDisabled: true });
      await removeCatCafeSkillCapabilities(projectRoot, sourceRemoved);
    }
    await disablePolicyDisabledCapabilities(
      projectRoot,
      fullyUnmounted.filter((skillName) => disabledSet.has(skillName)),
    );

    await Promise.all(snapshots.map(({ snapshot }) => discardMutablePath(snapshot).catch(() => {})));

    return {
      mounted: mounted.sort(),
      unmounted: unmounted.sort(),
      overridden: overridden.sort(),
      skipped: skipped.sort(),
      resolvedFrom: drift,
    };
  } catch (err) {
    for (const entry of snapshots.reverse()) {
      await restoreMutablePath(entry.path, entry.snapshot).catch(() => {});
    }
    throw err;
  }
}

export { ignoreDrift } from './drift-helpers.js';
