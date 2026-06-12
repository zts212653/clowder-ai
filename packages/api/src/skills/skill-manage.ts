/**
 * Skill Management — unified public API for skill CRUD + query.
 *
 * Public surface: addSkill / removeSkill / listSkills / querySkill
 * Consumers (PluginResourceActivator, capabilities route, console detail view, etc.)
 * call these functions. Config writes + symlink operations are handled internally.
 */

import { mkdir, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { type CapabilityEntry, type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { buildSkillMountTargets } from '../utils/skill-mount.js';
import { parseManifestSkillMeta, readSkillMeta } from './skill-meta.js';
import { classifyMountPath, type MountConflict } from './skill-sync-engine.js';

// ────────── Types ──────────

interface ProviderTarget {
  id: string;
  dirs: string[];
}

export interface AddSkillOptions {
  mountRules: MountRules;
  /** Plugin ID — present for plugin-provided skills. */
  pluginId?: string;
  /** Capability entry ID in config. Defaults to skillName for cat-cafe skills.
   *  Plugin skills use namespaced IDs (e.g. `plugin:foo:my-skill`). */
  capabilityId?: string;
  /** Mount to specific providers only; undefined = all active providers. */
  mountPaths?: readonly string[];
  /** Default: true. Set false to register the skill as disabled. */
  enabled?: boolean;
}

export interface SkillOperationResult {
  mounted: Array<{ skillName: string; providerId: string }>;
  unmounted: Array<{ skillName: string; providerId: string }>;
  conflicts: MountConflict[];
}

export interface RemoveSkillOptions {
  mountRules: MountRules;
  pluginId?: string;
  /** Capability entry ID in config. Defaults to skillName. */
  capabilityId?: string;
  /** Needed to identify managed symlinks for cleanup. */
  skillsSource?: string;
}

// ────────── Internals ──────────

function symlinkTargetFor(linkPath: string, sourcePath: string): string {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

function activeProviderTargets(projectRoot: string, rules: MountRules): ProviderTarget[] {
  const standard = STANDARD_PROVIDER_IDS.filter((id) => rules.providers[id].enabled).map((id) => ({
    id,
    dirs: [join(projectRoot, rules.providers[id].path)],
  }));
  const custom = buildSkillMountTargets(projectRoot, homedir(), rules)
    .filter((t) => t.kind === 'custom')
    .map((t) => ({ id: t.id, dirs: t.candidates }));
  return [...standard, ...custom];
}

function allProviderDirs(projectRoot: string, rules: MountRules): string[] {
  const standardDirs = STANDARD_PROVIDER_IDS.map((id) => join(projectRoot, rules.providers[id].path));
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

// ────────── Symlink helpers (shared by addSkill and PluginResourceActivator) ──────────

/**
 * Mount symlinks for a skill into active provider directories.
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
  const targets = activeProviderTargets(projectRoot, mountRules);
  const allowed = mountPaths ? new Set(mountPaths) : null;

  for (const target of targets) {
    if (allowed && !allowed.has(target.id)) {
      for (const dir of target.dirs) {
        const linkPath = join(dir, skillName);
        if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
          await rm(linkPath);
          result.unmounted.push({ skillName, providerId: target.id });
        }
      }
      continue;
    }
    for (const dir of target.dirs) {
      await mkdir(dir, { recursive: true });
      const linkPath = join(dir, skillName);
      const status = await classifyMountPath(linkPath, skillsSource, skillName);
      if (status === 'missing') {
        await symlink(symlinkTargetFor(linkPath, join(skillsSource, skillName)), linkPath);
        result.mounted.push({ skillName, providerId: target.id });
      } else if (status === 'conflict') {
        result.conflicts.push({ skillName, providerId: target.id, path: linkPath });
      }
    }
  }
  return result;
}

/**
 * Remove managed symlinks for a skill from all provider directories.
 * Pure filesystem operation — does not touch capabilities config.
 */
export async function unmountSkillSymlinks(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
): Promise<SkillOperationResult> {
  const result: SkillOperationResult = { mounted: [], unmounted: [], conflicts: [] };
  for (const dir of allProviderDirs(projectRoot, mountRules)) {
    const linkPath = join(dir, skillName);
    if ((await classifyMountPath(linkPath, skillsSource, skillName)) === 'managed') {
      await rm(linkPath);
      result.unmounted.push({ skillName, providerId: 'cleanup' });
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
 * status should call `classifyMountPath` per provider themselves.
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

  // 1. Config: upsert capability entry
  const config = (await readCapabilitiesConfig(projectRoot)) ?? {
    version: 2 as const,
    capabilities: [] as CapabilityEntry[],
  };
  const existing = findSkillEntry(config.capabilities, capId, pluginId);
  if (existing) {
    existing.enabled = enabled;
    if (opts.mountPaths) existing.mountPaths = [...opts.mountPaths];
  } else {
    config.capabilities.push({
      id: capId,
      type: 'skill',
      enabled,
      source: 'cat-cafe',
      ...(pluginId ? { pluginId } : {}),
      ...(opts.mountPaths ? { mountPaths: [...opts.mountPaths] } : {}),
    });
  }
  await writeCapabilitiesConfig(projectRoot, config);

  // 2. Mount symlinks
  if (!enabled) return { mounted: [], unmounted: [], conflicts: [] };
  return mountSkillSymlinks(projectRoot, skillName, skillsSource, mountRules, opts.mountPaths);
}

/**
 * Remove a skill from a project: disable config entry + unmount symlinks.
 *
 * Config is written BEFORE unmounting. Managed symlinks are removed from ALL
 * provider directories (active + disabled) to ensure full cleanup.
 */
export async function removeSkill(
  projectRoot: string,
  skillName: string,
  opts: RemoveSkillOptions,
): Promise<SkillOperationResult> {
  const { mountRules, pluginId } = opts;
  const capId = opts.capabilityId ?? skillName;

  // 1. Config: disable capability entry
  const config = await readCapabilitiesConfig(projectRoot);
  if (config) {
    const existing = findSkillEntry(config.capabilities, capId, pluginId);
    if (existing) {
      existing.enabled = false;
      existing.mountPaths = [];
      await writeCapabilitiesConfig(projectRoot, config);
    }
  }

  // 2. Remove managed symlinks from ALL provider dirs
  if (!opts.skillsSource) return { mounted: [], unmounted: [], conflicts: [] };
  return unmountSkillSymlinks(projectRoot, skillName, opts.skillsSource, mountRules);
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
