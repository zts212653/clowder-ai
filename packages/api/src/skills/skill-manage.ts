/**
 * Skill Management — unified public API for skill CRUD.
 *
 * Public surface: addSkill / removeSkill
 * Consumers (PluginResourceActivator, capabilities route, etc.)
 * call these functions. Config writes + symlink operations are handled internally.
 *
 * Query functions (listSkills, querySkill) → skill-query.ts
 * Symlink operations (mountSkillSymlinks, unmountSkillSymlinks) → skill-mount-ops.ts
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { type CapabilitiesConfig, type CapabilityEntry, type MountRules } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { activeMountTargets, mountSkillSymlinks, unmountSkillSymlinks } from './skill-mount-ops.js';
import { syncAll } from './skill-sync-all.js';
import type { MountConflict } from './skill-sync-engine.js';

export { mountSkillSymlinks, unmountSkillSymlinks } from './skill-mount-ops.js';
// Re-export for consumers that import from skill-manage
export type { SkillDetail, SkillInfo } from './skill-query.js';
export { listSkills, querySkill } from './skill-query.js';

// ────────── Types ──────────

/** F228: Cascade skill changes to all governance-registered projects via syncAll.
 *  Caller provides the cat-cafe skills source dir; addSkill/removeSkill handles the rest.
 *  Non-critical — cascade failure logs a warning; user can sync manually via UI. */
export interface SkillCascadeOptions {
  /** Absolute path to cat-cafe-skills source dir (e.g. `resolveSkillsSourceDir()`). */
  catCafeSkillsSource: string;
}

export interface AddSkillOptions {
  mountRules: MountRules;
  /** Plugin ID — present for plugin-provided skills. */
  pluginId?: string;
  /** Capability entry ID in config. Defaults to skillName for cat-cafe skills.
   *  Plugin skills use namespaced IDs (e.g. `plugin:foo:my-skill`). */
  capabilityId?: string;
  /** Mount to specific mount points only; undefined = all active mount points. */
  mountPaths?: readonly string[];
  /** Default: true. Set false to register the skill as disabled. */
  enabled?: boolean;
  /** Source directory persisted for plugin-provided skills. */
  skillsSource?: string;
  /** Optional config store override for consumers that already own locking/injection. */
  configStore?: SkillConfigStore;
  /** Built-in skills source directory for collision guard. When omitted, falls
   *  back to cascade?.catCafeSkillsSource, then join(projectRoot, 'cat-cafe-skills'). */
  builtInSkillsSource?: string;
  /** When provided, cascade to governance-registered projects after adding. */
  cascade?: SkillCascadeOptions;
}

export interface SkillOperationResult {
  mounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  unmounted: Array<{ skillName: string; mountPointId: string; path: string }>;
  conflicts: MountConflict[];
}

export interface RemoveSkillOptions {
  mountRules: MountRules;
  pluginId?: string;
  /** Capability entry ID in config. Defaults to skillName. */
  capabilityId?: string;
  /** Needed to identify managed symlinks for cleanup. */
  skillsSource?: string;
  /** Optional config store override for consumers that already own locking/injection. */
  configStore?: SkillConfigStore;
  /** When provided, cascade removal to governance-registered projects. */
  cascade?: SkillCascadeOptions;
}

export interface SkillConfigStore {
  readCapabilities: () => Promise<CapabilitiesConfig | null>;
  writeCapabilities: (config: CapabilitiesConfig) => Promise<void>;
}

// ────────── Internals ──────────

/**
 * F228: Cascade skill changes to all governance-registered projects.
 *
 * After addSkill/removeSkill updates the main project, syncAll propagates
 * the change (config entry + symlinks) to every external project in the
 * governance registry. syncAll internally builds globalCustomSourceSkills
 * from the main config, so plugin skill sources resolve correctly.
 */
export async function cascadeToProjects(mainProjectRoot: string, catCafeSkillsSource: string): Promise<void> {
  try {
    const cascadeMountRules = await readMountRules(mainProjectRoot, mainProjectRoot);
    await syncAll(mainProjectRoot, catCafeSkillsSource, {
      mountRules: cascadeMountRules,
      force: false,
    });
  } catch (err) {
    console.warn(`[F228] Skill cascade to projects failed (non-critical): ${(err as Error).message}`);
  }
}

function findSkillEntry(
  capabilities: CapabilityEntry[],
  capabilityId: string,
  pluginId?: string,
): CapabilityEntry | undefined {
  return capabilities.find(
    (c) =>
      c.type === 'skill' &&
      c.id === capabilityId &&
      c.source === 'cat-cafe' &&
      (pluginId ? c.pluginId === pluginId : !c.pluginId),
  );
}

async function writeCapabilitiesWithRollback(
  store: SkillConfigStore,
  previous: CapabilitiesConfig | null,
  next: CapabilitiesConfig,
): Promise<void> {
  try {
    await store.writeCapabilities(next);
  } catch (err) {
    const rollback = previous ?? { version: 2 as const, capabilities: [] as CapabilityEntry[] };
    try {
      await store.writeCapabilities(structuredClone(rollback));
    } catch {
      /* best-effort: original write error is the one callers need */
    }
    throw err;
  }
}

// ────────── Public API ──────────

/**
 * Add a skill to a project: upsert config entry + mount symlinks.
 *
 * Config is written BEFORE mounting — same safety contract as PATCH handler.
 * Conflicts are skipped and recorded (never thrown).
 */
export async function addSkill(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  opts: AddSkillOptions,
): Promise<SkillOperationResult> {
  const { mountRules, enabled = true, pluginId } = opts;
  const capId = opts.capabilityId ?? skillName;
  const store = opts.configStore ?? {
    readCapabilities: () => readCapabilitiesConfig(projectRoot),
    writeCapabilities: (config: CapabilitiesConfig) => writeCapabilitiesConfig(projectRoot, config),
  };

  // 1. Config: upsert capability entry
  const previous = await store.readCapabilities();
  const config = previous
    ? structuredClone(previous)
    : {
        version: 2 as const,
        capabilities: [] as CapabilityEntry[],
      };
  // Guard: reject plugin skills whose capId collides with a built-in skill.
  // The sync pipeline (syncProject / updateSkillMountPaths) uses bare cap.id
  // as map key, so same-id entries from different sources would pollute each
  // other's mountPaths and enabled state. Rather than rewriting the entire
  // sync pipeline to use composite keys, prevent the collision at the gate.
  // Two checks: (1) config already has a first-party entry, (2) built-in
  // source directory exists on disk (covers clean-config / first-install).
  if (pluginId) {
    const builtInConfigCollision = config.capabilities.find(
      (c) => c.type === 'skill' && c.id === capId && c.source === 'cat-cafe' && !c.pluginId,
    );
    // Prefer explicit builtInSkillsSource; fall back to cascade option, then
    // project root heuristic (correct when projectRoot IS the instance root,
    // which is the only valid call site for plugin registration).
    const builtInSkillsRoot =
      opts.builtInSkillsSource ?? opts.cascade?.catCafeSkillsSource ?? join(projectRoot, 'cat-cafe-skills');
    const builtInDirExists = existsSync(join(builtInSkillsRoot, capId));
    if (builtInConfigCollision || builtInDirExists) {
      throw new Error(
        `Plugin skill "${capId}" (plugin: ${pluginId}) conflicts with built-in skill "${capId}". ` +
          'Plugin skills must use a unique name that does not match any built-in skill.',
      );
    }
    // Guard: reject cross-plugin skill ID collisions. Two plugins with the same
    // skill basename (e.g. `skills/publish`) would share bare `cap.id` in
    // syncProject/updateSkillMountPaths maps, overwriting each other's state.
    const crossPluginCollision = config.capabilities.find(
      (c) => c.type === 'skill' && c.id === capId && c.source === 'cat-cafe' && c.pluginId && c.pluginId !== pluginId,
    );
    if (crossPluginCollision) {
      throw new Error(
        `Plugin skill "${capId}" (plugin: ${pluginId}) conflicts with skill "${capId}" ` +
          `from plugin "${crossPluginCollision.pluginId}". Plugin skills must have unique names across all plugins.`,
      );
    }
  }

  // Look up existing entry BEFORE computing mountPaths so we can preserve
  // user-customized mount policy on idempotent re-activation (e.g. server
  // restart, plugin manifest update). Without this, addSkill defaults to all
  // active mount targets and silently overwrites per-project mount choices.
  const existing = findSkillEntry(config.capabilities, capId, pluginId);

  // Compute effective mountPaths: caller-specified > existing policy > active mount targets.
  // Same contract as updateSkillMountPaths in skill-sync-config — always explicit,
  // never undefined. Each project (main or external) gets mountPaths derived from
  // its own mount rules; the caller (e.g. PluginResourceActivator) shouldn't need
  // to know per-project mount topology.
  //
  // Re-enable transition (disabled → enabled): reset mountPaths to all active targets
  // rather than preserving stale mount restrictions from the disabled state. The old
  // mountPaths were the state at disable-time and don't reflect the user's intent when
  // they click "enable plugin".  Idempotent re-activation (already enabled) preserves
  // the existing policy.
  const wasDisabled = existing && existing.enabled === false;
  const effectiveMountPaths = opts.mountPaths
    ? [...opts.mountPaths]
    : existing?.mountPaths?.length && !wasDisabled
      ? [...existing.mountPaths]
      : enabled
        ? activeMountTargets(projectRoot, mountRules).map((t) => t.id)
        : [];

  if (existing) {
    existing.enabled = enabled;
    existing.globalEnabled = enabled;
    existing.mountPaths = effectiveMountPaths;
    if (opts.skillsSource) existing.skillsSource = opts.skillsSource;
  } else {
    config.capabilities.push({
      id: capId,
      type: 'skill',
      enabled,
      source: 'cat-cafe',
      ...(pluginId ? { pluginId } : {}),
      mountPaths: effectiveMountPaths,
      ...(opts.skillsSource ? { skillsSource: opts.skillsSource } : {}),
    });
  }
  await writeCapabilitiesWithRollback(store, previous, config);

  // 2. Mount symlinks — use effectiveMountPaths (not opts.mountPaths) so the
  // filesystem matches the config entry written above.  opts.mountPaths is the
  // raw caller input and may be undefined, which would mount everywhere even
  // when the effective policy restricts to a subset (Codex R3 P2).
  const result: SkillOperationResult = enabled
    ? await mountSkillSymlinks(
        projectRoot,
        skillName,
        skillsSource,
        mountRules,
        effectiveMountPaths,
        pluginId
          ? (opts.builtInSkillsSource ?? opts.cascade?.catCafeSkillsSource ?? join(projectRoot, 'cat-cafe-skills'))
          : skillsSource,
      )
    : { mounted: [], unmounted: [], conflicts: [] };

  // 3. Cascade to governance-registered projects (non-critical)
  if (opts.cascade) {
    await cascadeToProjects(projectRoot, opts.cascade.catCafeSkillsSource);
  }

  return result;
}

/**
 * Remove a skill from a project: disable config entry + unmount symlinks.
 *
 * Config is written BEFORE unmounting. Managed symlinks are removed from ALL
 * mount point directories (active + disabled) to ensure full cleanup.
 */
export async function removeSkill(
  projectRoot: string,
  skillName: string,
  opts: RemoveSkillOptions,
): Promise<SkillOperationResult> {
  const { mountRules, pluginId } = opts;
  const capId = opts.capabilityId ?? skillName;
  const store = opts.configStore ?? {
    readCapabilities: () => readCapabilitiesConfig(projectRoot),
    writeCapabilities: (config: CapabilitiesConfig) => writeCapabilitiesConfig(projectRoot, config),
  };

  // Design note: removeSkill order differs for plugin vs built-in skills.
  //
  // Built-in (toggle off):
  //   disable main config → unmount → cascade (propagates disable)
  //   Entry stays in config with mountPaths:[] for re-enable later.
  //
  // Plugin (permanent removal):
  //   save entry info → purge from main config → unmount → cascade
  //   Cascade runs AFTER purge so orphan detection in syncProject fires:
  //   globalCustomSourceSkills won't contain the skill → orphan check
  //   removes the entry from external projects via removedNames path.
  //   If cascade ran before purge, the entry would still be in
  //   globalCustomSourceSkills and orphan detection wouldn't trigger,
  //   leaving stale entries in external projects.

  // 1. Read entry info before modifying config
  const previous = await store.readCapabilities();
  const config = previous ? structuredClone(previous) : null;
  let storedSkillsSource: string | undefined;
  if (config) {
    const existing = findSkillEntry(config.capabilities, capId, pluginId);
    if (existing) {
      storedSkillsSource = existing.skillsSource;
    }
  }

  // 2. Update main config: purge for plugin skills, disable for built-in
  if (config) {
    if (pluginId) {
      // Plugin: purge the entry entirely so cascade triggers orphan detection
      config.capabilities = config.capabilities.filter(
        (c) => !(c.type === 'skill' && c.id === capId && c.pluginId === pluginId),
      );
    } else {
      // Built-in: disable (keep entry for re-enable)
      const existing = findSkillEntry(config.capabilities, capId, pluginId);
      if (existing) {
        existing.enabled = false;
        existing.globalEnabled = false;
        existing.mountPaths = [];
      }
    }
    await writeCapabilitiesWithRollback(store, previous, config);
  }

  // 3. Remove managed symlinks from ALL mount point dirs
  const resolvedSource = opts.skillsSource ?? (storedSkillsSource ? join(projectRoot, storedSkillsSource) : undefined);
  const result: SkillOperationResult = resolvedSource
    ? await unmountSkillSymlinks(projectRoot, skillName, resolvedSource, mountRules)
    : { mounted: [], unmounted: [], conflicts: [] };

  // 4. Cascade to governance-registered projects (non-critical).
  // For plugin skills: entry is already purged, so syncAll's
  //   globalCustomSourceSkills won't contain it → orphan detection fires
  //   → entry removed from external projects.
  // For built-in skills: entry is disabled, so cascade propagates
  //   the disable state to external projects.
  if (opts.cascade) {
    await cascadeToProjects(projectRoot, opts.cascade.catCafeSkillsSource);
  }

  return result;
}
