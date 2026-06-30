/**
 * Skill Management — unified public API for skill CRUD + query.
 *
 * Public surface: addSkill / removeSkill / listSkills / querySkill
 * Consumers (PluginResourceActivator, capabilities route, console detail view, etc.)
 * call these functions. Config writes + symlink operations are handled internally.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import {
  type CapabilitiesConfig,
  type CapabilityEntry,
  type MountRules,
  STANDARD_MOUNT_POINT_IDS,
} from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { buildSkillMountTargets, createSkillSymlink } from '../utils/skill-mount.js';
import { parseManifestSkillMeta, readSkillMeta } from './skill-meta.js';
import { syncAll } from './skill-sync-all.js';
import { classifyMountPath, type MountConflict } from './skill-sync-engine.js';

// ────────── Types ──────────

interface MountTarget {
  id: string;
  dirs: string[];
}

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

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

function activeMountTargets(projectRoot: string, rules: MountRules): MountTarget[] {
  const standard = STANDARD_MOUNT_POINT_IDS.filter((id) => rules.mountPoints[id].enabled).map((id) => ({
    id,
    dirs: [join(projectRoot, rules.mountPoints[id].path)],
  }));
  const custom = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .map((t) => ({ id: t.id, dirs: t.candidates }));
  return [...standard, ...custom];
}

function allMountDirs(projectRoot: string, rules: MountRules): string[] {
  const standardDirs = STANDARD_MOUNT_POINT_IDS.map((id) => join(projectRoot, rules.mountPoints[id].path));
  const customDirs = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .flatMap((t) => t.candidates);
  return [...new Set([...standardDirs, ...customDirs])];
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
    const rollback = previous ?? { version: 1, capabilities: [] };
    try {
      await store.writeCapabilities(structuredClone(rollback));
    } catch {
      /* best-effort: original write error is the one callers need */
    }
    throw err;
  }
}

// ────────── Symlink helpers (shared by addSkill and PluginResourceActivator) ──────────

/**
 * Mount symlinks for a skill into active mount point directories.
 * Pure filesystem operation — does not touch capabilities config.
 */
export async function mountSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
  mountPaths?: readonly string[],
): Promise<SkillOperationResult> {
  const result: SkillOperationResult = { mounted: [], unmounted: [], conflicts: [] };
  const targets = activeMountTargets(projectRoot, mountRules);
  const allowed = mountPaths ? new Set(mountPaths) : null;

  for (const target of targets) {
    if (allowed && !allowed.has(target.id)) {
      for (const dir of target.dirs) {
        // Guard: skip symlinked mount dirs (same as mount branch below)
        try {
          const s = await lstat(dir);
          if (s.isSymbolicLink() || !s.isDirectory()) continue;
        } catch {
          continue;
        }
        const linkPath = join(dir, skillName);
        if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
          await rm(linkPath);
          result.unmounted.push({ skillName, mountPointId: target.id, path: linkPath });
        }
      }
      continue;
    }
    for (const dir of target.dirs) {
      // Guard: reject symlinked mount dirs to prevent writing outside project
      try {
        const dirStat = await lstat(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          result.conflicts.push({ skillName, mountPointId: target.id, path: dir });
          continue;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          result.conflicts.push({ skillName, mountPointId: target.id, path: dir });
          continue;
        }
      }
      await mkdir(dir, { recursive: true });
      const linkPath = join(dir, skillName);
      const status = await classifyMountPath(linkPath, skillsSource, skillName);
      if (status === 'missing') {
        await createSkillSymlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
        result.mounted.push({ skillName, mountPointId: target.id, path: linkPath });
      } else if (status === 'conflict') {
        result.conflicts.push({ skillName, mountPointId: target.id, path: linkPath });
      }
    }
  }
  return result;
}

/**
 * Remove managed symlinks for a skill from all mount point directories.
 * Pure filesystem operation — does not touch capabilities config.
 */
export async function unmountSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
): Promise<SkillOperationResult> {
  const result: SkillOperationResult = { mounted: [], unmounted: [], conflicts: [] };
  for (const dir of allMountDirs(projectRoot, mountRules)) {
    // Guard: skip symlinked mount dirs to avoid following into external targets
    try {
      const dirStat = await lstat(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    const linkPath = join(dir, skillName);
    if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
      await rm(linkPath);
      result.unmounted.push({ skillName, mountPointId: 'cleanup', path: linkPath });
    }
  }
  return result;
}

// ────────── Public API ──────────

export interface SkillInfo {
  /** Capability entry ID (e.g. 'tdd' or 'plugin:foo:my-skill'). */
  id: string;
  enabled: boolean;
  pluginId?: string;
  mountPaths?: readonly string[];
}

/**
 * List all cat-cafe managed skills configured for a project.
 *
 * Pure config read — no filesystem checks. Consumers that need mount
 * status should call `classifyMountPath` per mount point themselves.
 */
export async function listSkills(projectRoot: string): Promise<SkillInfo[]> {
  const config = await readCapabilitiesConfig(projectRoot);
  if (!config) return [];

  return config.capabilities
    .filter((c) => c.type === 'skill' && c.source === 'cat-cafe')
    .map((c) => ({
      id: c.id,
      enabled: c.enabled ?? false,
      ...(c.pluginId ? { pluginId: c.pluginId } : {}),
      ...(c.mountPaths?.length ? { mountPaths: c.mountPaths } : {}),
    }));
}

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
    const builtInSkillsRoot = opts.cascade?.catCafeSkillsSource ?? join(projectRoot, 'cat-cafe-skills');
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
    ? await mountSkillSymlinks(projectRoot, skillName, skillsSource, mountRules, effectiveMountPaths)
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
  //   disable main config → cascade (propagates disable) → unmount
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

// ────────── Query ──────────

export interface SkillDetail extends SkillInfo {
  description?: string;
  triggers?: string[];
  category?: string;
}

/**
 * Query detailed information about a single skill.
 *
 * Combines config state (enabled/mountPaths) with metadata from
 * SKILL.md frontmatter and manifest.yaml. Used by console detail view.
 */
export async function querySkill(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
): Promise<SkillDetail | null> {
  const skills = await listSkills(projectRoot);
  const info = skills.find((s) => s.id === skillName || s.id.endsWith(`:${skillName}`));

  const skillDir = join(skillsSource, skillName);
  const [skillMeta, manifestMeta] = await Promise.all([readSkillMeta(skillDir), parseManifestSkillMeta(skillsSource)]);
  const manifest = manifestMeta.get(skillName);

  // Skill not in config AND not in source → doesn't exist
  if (!info && !manifest && !skillMeta.description) return null;

  return {
    id: info?.id ?? skillName,
    enabled: info?.enabled ?? false,
    ...(info?.pluginId ? { pluginId: info.pluginId } : {}),
    ...(info?.mountPaths ? { mountPaths: info.mountPaths } : {}),
    description: manifest?.description ?? skillMeta.description,
    triggers: manifest?.triggers ?? skillMeta.triggers,
    category: manifest?.category,
  };
}
