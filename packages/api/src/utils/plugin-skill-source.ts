/**
 * Plugin Skill Source Resolution — F228
 *
 * Resolves plugin skill source paths from capabilities.json entries.
 * Used by mount-rules reconciliation and skill sync to handle plugin
 * skills alongside built-in cat-cafe skills with the same mount/unmount
 * primitives (source-agnostic execution layer).
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import { resolvePluginResourcePath, resourcePathBasename } from '../domains/plugin/PluginRegistry.js';
import { parsePluginManifest } from '../domains/plugin/plugin-manifest.js';

export interface PluginSkillInfo {
  pluginId: string;
  /** Skill directory name (= capability ID for skill-type resources). */
  skillName: string;
  /** Parent directory of the skill source dir — pass as `skillsSource` to mount/unmount. */
  skillsSource: string;
  enabled: boolean;
  mountPaths?: string[];
}

export function pluginSkillSourceDirsForProject(canonicalPluginsDir: string, projectRoot: string): string[] {
  const dirs = [canonicalPluginsDir];
  const projectPluginsDir = join(projectRoot, 'plugins');
  if (resolve(projectPluginsDir) !== resolve(canonicalPluginsDir)) dirs.push(projectPluginsDir);
  return dirs;
}

type PluginSkillCap = CapabilitiesConfig['capabilities'][number] & { pluginId: string };
type SelectedPluginManifest = { manifest: ReturnType<typeof parsePluginManifest>; pluginsDir: string };

function groupPluginSkillCapabilities(config: CapabilitiesConfig): Map<string, PluginSkillCap[]> {
  const byPlugin = new Map<string, PluginSkillCap[]>();
  for (const cap of config.capabilities) {
    if (cap.type !== 'skill' || !cap.pluginId) continue;
    const group = byPlugin.get(cap.pluginId) ?? [];
    group.push(cap as PluginSkillCap);
    byPlugin.set(cap.pluginId, group);
  }
  return byPlugin;
}

function selectPluginManifest(pluginId: string, pluginsDirs: readonly string[]): SelectedPluginManifest | null {
  let selected: SelectedPluginManifest | null = null;
  for (const pluginsDir of pluginsDirs) {
    const manifestPath = join(pluginsDir, pluginId, 'plugin.yaml');
    if (!existsSync(manifestPath)) continue;
    try {
      selected = { manifest: parsePluginManifest(manifestPath), pluginsDir };
    } catch {
      // Invalid manifests are ignored here; plugin activation owns validation errors.
    }
  }
  return selected;
}

function resolvePluginSkillInfo(cap: PluginSkillCap, selected: SelectedPluginManifest): PluginSkillInfo | null {
  const skillResource = selected.manifest.resources.find(
    (r) => r.type === 'skill' && r.path && resourcePathBasename(r.path) === cap.id,
  );
  if (!skillResource?.path) return null;

  const skillSourceDir = resolvePluginResourcePath(selected.pluginsDir, cap.pluginId, skillResource.path);
  if (!existsSync(skillSourceDir)) return null;

  // Containment check: resolved path must stay within the plugin root
  // (mirrors PluginResourceActivator.assertPluginResourceInsideRoot)
  try {
    const realDir = realpathSync(skillSourceDir);
    const pluginRoot = realpathSync(join(selected.pluginsDir, cap.pluginId));
    const rel = relative(pluginRoot, realDir);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
  } catch {
    return null;
  }

  return {
    pluginId: cap.pluginId,
    skillName: cap.id,
    skillsSource: dirname(skillSourceDir),
    enabled: cap.enabled !== false,
    mountPaths: cap.mountPaths,
  };
}

export function resolvePluginSkillSourcesFromDirs(
  config: CapabilitiesConfig | null,
  pluginsDirs: readonly string[],
): PluginSkillInfo[] {
  if (!config) return [];

  const results: PluginSkillInfo[] = [];
  const byPlugin = groupPluginSkillCapabilities(config);

  for (const [pluginId, caps] of byPlugin) {
    const selected = selectPluginManifest(pluginId, pluginsDirs);
    if (!selected) continue;

    for (const cap of caps) {
      const info = resolvePluginSkillInfo(cap, selected);
      if (info) results.push(info);
    }
  }

  return results;
}

/**
 * Resolve plugin skill source paths from a capabilities config.
 *
 * For each plugin skill capability entry, parses the corresponding plugin
 * manifest to find the actual filesystem path. Returns only entries whose
 * source directories exist on disk. Parses each manifest at most once.
 */
export function resolvePluginSkillSources(config: CapabilitiesConfig | null, pluginsDir: string): PluginSkillInfo[] {
  return resolvePluginSkillSourcesFromDirs(config, [pluginsDir]);
}

export function resolvePluginSkillSourcesForProject(
  config: CapabilitiesConfig | null,
  canonicalPluginsDir: string,
  projectRoot: string,
): PluginSkillInfo[] {
  return resolvePluginSkillSourcesFromDirs(config, pluginSkillSourceDirsForProject(canonicalPluginsDir, projectRoot));
}
