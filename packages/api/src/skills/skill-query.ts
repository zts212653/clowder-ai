/**
 * Skill Query — read-only query functions for skill config + metadata.
 *
 * Pure config reads — no filesystem mutations. Consumers that need mount
 * status should call `classifyMountPath` per mount point themselves.
 */

import { join } from 'node:path';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { parseManifestSkillMeta, readSkillMeta } from './skill-meta.js';

// ────────── Types ──────────

export interface SkillInfo {
  /** Capability entry ID (e.g. 'tdd' or 'plugin:foo:my-skill'). */
  id: string;
  enabled: boolean;
  pluginId?: string;
  mountPaths?: readonly string[];
}

export interface SkillDetail extends SkillInfo {
  description?: string;
  triggers?: string[];
  category?: string;
}

// ────────── Public API ──────────

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
