/** F228: Cross-project skill propagation (extracted from routes/capabilities.ts). */

import type {
  CapabilitiesConfig,
  CapabilityEntry,
  CapabilityPatchRequest,
  MountRules,
  StandardProviderId,
} from '@cat-cafe/shared';
import { STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { listSourceSkillNames } from '../config/governance/skills-state.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import {
  convertManagedDirectoryLevelSkillMountsForPolicy,
  discardSkillMountSnapshot,
  filterRulesToProvider,
  mountSkillForProject,
  restoreSkillMountSnapshot,
  snapshotSkillMountsForProject,
  unmountSkillForProject,
} from './skill-symlink-writer.js';

const STANDARD_PROVIDER_SET = new Set<string>(STANDARD_PROVIDER_IDS);

function isProviderMountableInRules(rules: MountRules, providerId: string): boolean {
  if (STANDARD_PROVIDER_SET.has(providerId)) {
    return rules.providers[providerId as StandardProviderId]?.enabled === true;
  }
  return (rules.customPaths ?? []).some((cp) => cp.alias === providerId);
}

export function enabledMountTargetIds(rules: MountRules): string[] {
  return [
    ...STANDARD_PROVIDER_IDS.filter((id) => rules.providers[id].enabled),
    ...(rules.customPaths ?? []).map((cp) => cp.alias),
  ];
}

export function filterRulesToMountTargets(rules: MountRules, providerIds: ReadonlySet<string>): MountRules {
  const filtered = structuredClone(rules);
  for (const id of STANDARD_PROVIDER_IDS) {
    filtered.providers[id].enabled = rules.providers[id].enabled && providerIds.has(id);
  }
  filtered.customPaths = (rules.customPaths ?? []).filter((cp) => providerIds.has(cp.alias));
  return filtered;
}

export function currentSkillMountTargetIds(cap: CapabilityEntry, rules: MountRules): string[] {
  if (Array.isArray(cap.mountPaths)) return cap.mountPaths;
  return cap.enabled ? enabledMountTargetIds(rules) : [];
}
export function findCatCafeSkillCapability(
  config: { capabilities: CapabilityEntry[] } | null | undefined,
  skillId: string,
): CapabilityEntry | null {
  return (
    config?.capabilities.find(
      (entry) => entry.type === 'skill' && entry.id === skillId && entry.source === 'cat-cafe' && !entry.pluginId,
    ) ?? null
  );
}

export function createCatCafeSkillCapabilityFromGlobalPolicy(
  skillId: string,
  globalCap: CapabilityEntry | null,
): CapabilityEntry {
  const entry: CapabilityEntry = {
    id: skillId,
    type: 'skill',
    enabled: true,
    source: 'cat-cafe',
  };
  if (!globalCap) return entry;

  entry.enabled = globalCap.enabled;
  if (Array.isArray(globalCap.mountPaths)) {
    entry.mountPaths = [...globalCap.mountPaths];
  } else if (!globalCap.enabled) {
    entry.mountPaths = [];
  }
  return entry;
}
export function findCapabilityPatchTargetIndex(
  config: { capabilities: CapabilityEntry[] },
  body: CapabilityPatchRequest,
): number {
  const hasSourceDiscriminator = body.source === 'cat-cafe' || body.source === 'external';
  const hasPluginDiscriminator = typeof body.pluginId === 'string';

  if (hasSourceDiscriminator || hasPluginDiscriminator) {
    const explicitIndex = config.capabilities.findIndex((entry) => {
      if (entry.id !== body.capabilityId || entry.type !== body.capabilityType) return false;
      if (hasSourceDiscriminator && entry.source !== body.source) return false;
      if (hasPluginDiscriminator) return entry.pluginId === body.pluginId;
      return !entry.pluginId;
    });
    if (explicitIndex !== -1) return explicitIndex;
  }

  if (body.capabilityType === 'skill') {
    const firstPartyIndex = config.capabilities.findIndex(
      (entry) =>
        entry.id === body.capabilityId && entry.type === 'skill' && entry.source === 'cat-cafe' && !entry.pluginId,
    );
    if (firstPartyIndex !== -1) return firstPartyIndex;
  }

  return config.capabilities.findIndex((entry) => entry.id === body.capabilityId && entry.type === body.capabilityType);
}
function isSkillMountPolicyAllowedForProvider(
  config: CapabilitiesConfig | null | undefined,
  skillId: string,
  providerId: string,
  rules: MountRules,
  disabledSkillIds: ReadonlySet<string>,
): boolean {
  if (disabledSkillIds.has(skillId)) return false;
  const cap = findCatCafeSkillCapability(config, skillId);
  if (!cap) return true;
  return currentSkillMountTargetIds(cap, rules).includes(providerId);
}

export async function convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy(
  projectRoot: string,
  skillsSource: string,
  rules: MountRules,
  config: CapabilitiesConfig | null | undefined,
  disabledSkillIds: ReadonlySet<string>,
): Promise<void> {
  const sourceSkillNames = await listSourceSkillNames(skillsSource);
  await convertManagedDirectoryLevelSkillMountsForPolicy(
    projectRoot,
    skillsSource,
    rules,
    enabledMountTargetIds(rules),
    (providerId) =>
      sourceSkillNames.filter((skillName) =>
        isSkillMountPolicyAllowedForProvider(config, skillName, providerId, rules, disabledSkillIds),
      ),
  );
}
function upsertCatCafeSkillCapability(
  config: { capabilities: CapabilityEntry[] },
  skillId: string,
  mountPaths: string[],
): CapabilityEntry {
  let cap = findCatCafeSkillCapability(config, skillId);
  if (!cap) {
    cap = {
      id: skillId,
      type: 'skill',
      enabled: mountPaths.length > 0,
      source: 'cat-cafe',
      mountPaths: [...mountPaths],
    };
    config.capabilities.push(cap);
    return cap;
  }
  cap.mountPaths = [...mountPaths];
  cap.enabled = mountPaths.length > 0;
  return cap;
}
function createEmptyCapabilitiesConfig(): CapabilitiesConfig {
  return { version: 2, capabilities: [] };
}
function filterRulesToProviderUnmountTarget(rules: MountRules, providerId: string): MountRules {
  const filtered = filterRulesToProvider(rules, providerId);
  if (STANDARD_PROVIDER_SET.has(providerId)) {
    filtered.providers[providerId as StandardProviderId].enabled = true;
  }
  return filtered;
}

type SnapshotHandle = Awaited<ReturnType<typeof snapshotSkillMountsForProject>>;

/** Iterate governance-registered external projects, collecting per-project warnings. */
async function forEachExternalProject(
  catCafeRoot: string,
  primaryProjectRoot: string,
  action: (projectPath: string) => Promise<void>,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
    const entries = await new GovernanceRegistry(catCafeRoot).listAll();
    for (const entry of entries) {
      if (entry.projectPath === primaryProjectRoot) continue;
      try {
        await action(entry.projectPath);
      } catch (err) {
        const msg = `${entry.projectPath}: ${(err as Error).message}`;
        console.warn(`[F228] ${msg}`);
        warnings.push(msg);
      }
    }
  } catch (registryErr) {
    const msg = `Failed to read governance registry: ${(registryErr as Error).message}`;
    console.warn(`[F228] ${msg}`);
    warnings.push(msg);
  }
  return warnings;
}

/** Execute `action` with a rollback snapshot; discard on success, restore on failure. */
async function withSnapshot(snapshot: SnapshotHandle, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    await discardSkillMountSnapshot(snapshot);
  } catch (err) {
    let rollbackSuffix = '';
    try {
      await restoreSkillMountSnapshot(snapshot);
    } catch (rollbackErr) {
      rollbackSuffix = ` Rollback also failed: ${(rollbackErr as Error).message}`;
    }
    throw new Error(`${(err as Error).message}${rollbackSuffix}`);
  }
}

/** Force-unmount a globally-disabled skill from all registered external projects. */
export async function propagateGlobalSkillDisable(
  catCafeRoot: string,
  primaryProjectRoot: string,
  skillId: string,
  skillsSource: string,
): Promise<string[]> {
  return forEachExternalProject(catCafeRoot, primaryProjectRoot, async (projectPath) => {
    const extMountRules = await readMountRules(projectPath, catCafeRoot);
    let extConfig = await readCapabilitiesConfig(projectPath);
    const disabledManagedSkillNames = new Set([skillId]);
    for (const cap of extConfig?.capabilities ?? []) {
      if (cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && !cap.enabled) {
        disabledManagedSkillNames.add(cap.id);
      }
    }
    // F228: Snapshot before mutation so we can rollback if config write fails.
    const snapshot = await snapshotSkillMountsForProject(projectPath, skillId, skillsSource, extMountRules, {
      enabledOnly: true,
      symlinksOnly: true,
    });
    await withSnapshot(snapshot, async () => {
      await convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy(
        projectPath,
        skillsSource,
        extMountRules,
        extConfig,
        disabledManagedSkillNames,
      );
      await unmountSkillForProject(projectPath, skillId, extMountRules, skillsSource);
      extConfig ??= { version: 2, capabilities: [] };
      if (extConfig.version === 1) extConfig.version = 2;
      let extCap = findCatCafeSkillCapability(extConfig, skillId);
      if (!extCap) {
        extCap = { id: skillId, type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] };
        extConfig.capabilities.push(extCap);
      }
      extCap.enabled = false;
      extCap.source = 'cat-cafe';
      extCap.mountPaths = [];
      await writeCapabilitiesConfig(projectPath, extConfig);
    });
  });
}

export interface PropagationConflict {
  projectPath: string;
  provider: string;
  skillId: string;
}

export interface PropagationResult {
  warnings: string[];
  conflicts: PropagationConflict[];
}

/**
 * Mount a globally-enabled skill to all registered external projects.
 * F228: Mounts per-provider individually so user-owned conflicts at one
 * provider don't block mounting at other providers. Conflicts are reported
 * as structured data for UI-driven override/skip resolution.
 */
export async function propagateGlobalSkillEnable(
  catCafeRoot: string,
  primaryProjectRoot: string,
  skillId: string,
  skillsSource: string,
): Promise<PropagationResult> {
  const allConflicts: PropagationConflict[] = [];
  const mainConfig = await readCapabilitiesConfig(catCafeRoot);
  const mainMountRules = await readMountRules(catCafeRoot, catCafeRoot);
  const globalCap = findCatCafeSkillCapability(mainConfig, skillId);
  const globalPolicy = globalCap ? new Set(currentSkillMountTargetIds(globalCap, mainMountRules)) : null;
  const warnings = await forEachExternalProject(catCafeRoot, primaryProjectRoot, async (projectPath) => {
    const extMountRules = await readMountRules(projectPath, catCafeRoot);
    // F228: Global policy cascades mount targets as default, not a constraint.
    // Don't unmount providers the project may have mounted independently.
    const effectiveRules = globalPolicy ? filterRulesToMountTargets(extMountRules, globalPolicy) : extMountRules;
    const targetProviders = enabledMountTargetIds(effectiveRules);
    const snapshot = await snapshotSkillMountsForProject(projectPath, skillId, skillsSource, extMountRules, {
      preserveNonSymlinks: true,
    });
    await withSnapshot(snapshot, async () => {
      // Mount per-provider individually: skip conflicts, mount non-conflicting providers.
      const mountedProviders: string[] = [];
      const localConflicts: PropagationConflict[] = [];
      for (const providerId of targetProviders) {
        try {
          await mountSkillForProject(
            projectPath,
            skillId,
            skillsSource,
            filterRulesToProvider(effectiveRules, providerId),
          );
          mountedProviders.push(providerId);
        } catch (mountErr) {
          if ((mountErr as Error).message?.includes('not a managed Cat Cafe skill symlink')) {
            localConflicts.push({ projectPath, provider: providerId, skillId });
          } else {
            throw mountErr;
          }
        }
      }
      // Preserve any existing project-level mounts outside the global policy.
      // In propagation context, mountPaths records ACTUAL mounted providers —
      // conflicted providers are excluded so drift detection surfaces them as
      // "config says not mounted, but user-owned file exists" rather than
      // "config says mounted, but link is wrong". This differs from syncDrift
      // where mountPaths stores declared policy; propagation has no per-project
      // policy yet, only a global cascade intent.
      const extConfig = (await readCapabilitiesConfig(projectPath)) ?? createEmptyCapabilitiesConfig();
      const existingCap = findCatCafeSkillCapability(extConfig, skillId);
      const existingMounts = existingCap ? currentSkillMountTargetIds(existingCap, extMountRules) : [];
      const nextMountPaths = [...new Set([...existingMounts, ...mountedProviders])];

      // No mounts to record and no existing capability entry to update —
      // skip config write to avoid creating phantom capability entries.
      if (nextMountPaths.length === 0 && !existingCap) {
        allConflicts.push(...localConflicts);
        return;
      }

      if (existingCap) {
        existingCap.mountPaths = nextMountPaths;
        existingCap.enabled = nextMountPaths.length > 0;
      } else {
        // After the guard above, !existingCap implies nextMountPaths.length > 0.
        extConfig.capabilities.push({
          id: skillId,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: nextMountPaths,
        });
      }
      await writeCapabilitiesConfig(projectPath, extConfig);
      // Commit conflicts only after config write succeeds
      allConflicts.push(...localConflicts);
    });
  });
  return { warnings, conflicts: allConflicts };
}

/** Toggle a single provider's mount for a skill across all registered external projects. */
export async function propagateGlobalProviderToggle(
  catCafeRoot: string,
  primaryProjectRoot: string,
  skillId: string,
  providerId: string,
  enabled: boolean,
  skillsSource: string,
  globalMountTargetIds?: readonly string[],
): Promise<string[]> {
  return forEachExternalProject(catCafeRoot, primaryProjectRoot, async (projectPath) => {
    const extMountRules = await readMountRules(projectPath, catCafeRoot);
    const providerMountable = isProviderMountableInRules(extMountRules, providerId);
    if (enabled && !providerMountable) return;
    const filteredRules = filterRulesToProvider(extMountRules, providerId);
    let snapshot: SnapshotHandle;
    if (enabled) {
      snapshot = await snapshotSkillMountsForProject(projectPath, skillId, skillsSource, filteredRules, {
        preserveNonSymlinks: true,
      });
    } else {
      const unmountRules = filterRulesToProviderUnmountTarget(extMountRules, providerId);
      snapshot = await snapshotSkillMountsForProject(projectPath, skillId, skillsSource, unmountRules, {
        enabledOnly: true,
        symlinksOnly: true,
      });
    }
    await withSnapshot(snapshot, async () => {
      const extConfig = (await readCapabilitiesConfig(projectPath)) ?? createEmptyCapabilitiesConfig();
      if (enabled) {
        await mountSkillForProject(projectPath, skillId, skillsSource, filteredRules);
      } else {
        // F228: Convert legacy directory-level roots before per-skill unmount,
        // matching the pattern in propagateGlobalSkillDisable (line 241).
        const disabledManagedSkillNames = new Set([skillId]);
        for (const cap of extConfig.capabilities) {
          if (cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && !cap.enabled) {
            disabledManagedSkillNames.add(cap.id);
          }
        }
        await convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy(
          projectPath,
          skillsSource,
          extMountRules,
          extConfig,
          disabledManagedSkillNames,
        );
        const unmountRules = filterRulesToProviderUnmountTarget(extMountRules, providerId);
        await unmountSkillForProject(projectPath, skillId, unmountRules, skillsSource, { enabledOnly: true });
      }
      const extCap = findCatCafeSkillCapability(extConfig, skillId);
      const inherited = globalMountTargetIds
        ? globalMountTargetIds.filter((t) => isProviderMountableInRules(extMountRules, t))
        : enabledMountTargetIds(extMountRules);
      const current = extCap
        ? currentSkillMountTargetIds(extCap, extMountRules)
        : enabled && !globalMountTargetIds
          ? []
          : inherited;
      const nextMountPaths = enabled ? [...new Set([...current, providerId])] : current.filter((p) => p !== providerId);
      upsertCatCafeSkillCapability(extConfig, skillId, nextMountPaths);
      await writeCapabilitiesConfig(projectPath, extConfig);
    });
  });
}
