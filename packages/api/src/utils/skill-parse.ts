/**
 * Skill Parsing Utilities
 *
 * Extracted from skills route to keep route file within size limits.
 * Handles manifest.yaml parsing and MCP resolution.
 *
 * manifest.yaml is the single source of truth for skill metadata:
 * category, description, triggers, MCP deps, and ordering (YAML key order).
 * BOOTSTRAP.md is human documentation only — not parsed at runtime.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readCapabilitiesConfig, resolveRequiredMcpStatus } from '../config/capabilities/capability-orchestrator.js';

export interface SkillMeta {
  category?: string;
  description?: string;
  triggers?: string[];
  requiresMcp?: string[];
}

export interface SkillMcpDependency {
  id: string;
  status: 'ready' | 'missing' | 'unresolved';
}

/** List subdirs that contain SKILL.md */
export async function listSkillDirs(skillsSrc: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsSrc, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      try {
        await readFile(join(skillsSrc, e.name, 'SKILL.md'), 'utf-8');
        names.push(e.name);
      } catch {
        // No SKILL.md, skip
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** Parse manifest.yaml and extract skill category/description/triggers. */
export async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const result = new Map<string, SkillMeta>();
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<
        string,
        { category?: unknown; description?: unknown; triggers?: unknown; requires_mcp?: unknown }
      >;
    } | null;
    if (!parsed?.skills || typeof parsed.skills !== 'object') return result;

    for (const [name, meta] of Object.entries(parsed.skills)) {
      const category = typeof meta?.category === 'string' ? meta.category.trim() : undefined;
      const description = typeof meta?.description === 'string' ? meta.description.trim() : undefined;
      const triggers = Array.isArray(meta?.triggers)
        ? meta.triggers
            .filter((v): v is string => typeof v === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const requiresMcp = Array.isArray(meta?.requires_mcp)
        ? meta.requires_mcp
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;
      const hasData =
        category || description || (triggers && triggers.length > 0) || (requiresMcp && requiresMcp.length > 0);
      if (hasData) {
        result.set(name, {
          ...(category ? { category } : {}),
          ...(description ? { description } : {}),
          ...(triggers && triggers.length > 0 ? { triggers } : {}),
          ...(requiresMcp && requiresMcp.length > 0 ? { requiresMcp } : {}),
        });
      }
    }
  } catch {
    // manifest missing or invalid
  }
  return result;
}

export async function resolveSkillMcpStatuses(
  projectRoot: string,
  manifestMeta: Map<string, SkillMeta>,
): Promise<Map<string, SkillMcpDependency>> {
  const capabilities = await readCapabilitiesConfig(projectRoot);
  const requiredIds = new Set<string>();
  for (const meta of manifestMeta.values()) {
    for (const id of meta.requiresMcp ?? []) requiredIds.add(id);
  }

  const statuses = new Map<string, SkillMcpDependency>();
  for (const id of requiredIds) {
    const resolved = await resolveRequiredMcpStatus(id, { capabilities, env: process.env });
    statuses.set(id, { id, status: resolved.status });
  }

  return statuses;
}
