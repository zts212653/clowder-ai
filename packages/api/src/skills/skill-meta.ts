/**
 * Skill Metadata — reads description/triggers/category from SKILL.md and manifest.yaml.
 *
 * Single source for skill metadata parsing. Consumed by:
 * - skill-manage.ts (querySkill)
 * - routes/capabilities.ts (board builder)
 * - routes/skills.ts (skills board + MCP status)
 */

import { readFile } from 'node:fs/promises';
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

/**
 * Extract description + triggers from a SKILL.md frontmatter.
 * Triggers are embedded in descriptions:
 *   'Triggers on "X", "Y", "Z"' or '触发词："X"、"Y"'
 */
export async function readSkillMeta(skillDir: string): Promise<SkillMeta> {
  const skillMdPath = join(skillDir, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = parseYaml(match[1]!) as { description?: unknown; triggers?: unknown } | null;
    const desc = typeof fm?.description === 'string' ? fm.description.trim() : '';
    if (!desc) return {};

    // Prefer explicit frontmatter `triggers` when available.
    const triggers: string[] = Array.isArray(fm?.triggers)
      ? fm?.triggers
          .filter((v): v is string => typeof v === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Backward compatibility: extract triggers from description text for legacy skills.
    if (triggers.length === 0) {
      // English: Triggers on "X", "Y", "Z"
      const enMatch = desc.match(/[Tt]riggers?\s+on\s+"([^"]+)"(,\s*"([^"]+)")*/);
      if (enMatch) {
        const allQuoted = desc.match(/[Tt]riggers?\s+on\s+(.*)/);
        if (allQuoted) {
          for (const m of allQuoted[1]?.matchAll(/"([^"]+)"/g)) {
            triggers.push(m[1]!);
          }
        }
      }
      // Chinese: 触发词："X"、"Y" or 触发词：X、Y
      const cnMatch = desc.match(/触发词[：:]\s*(.*)/);
      if (cnMatch) {
        const raw = cnMatch[1]!;
        // Quoted: "X"、"Y"
        for (const m of raw.matchAll(/["""]([^"""]+)["""]/g)) {
          triggers.push(m[1]!);
        }
        // Unquoted fallback: X、Y、Z
        if (triggers.length === 0) {
          triggers.push(
            ...raw
              .split(/[、,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    }

    // Clean description: strip trigger suffix for display
    let cleanDesc = desc
      .replace(/\s*[Tt]riggers?\s+on\s+.*$/, '')
      .replace(/\s*触发词[：:].*$/, '')
      .replace(/\.\s*$/, '')
      .trim();
    if (!cleanDesc) cleanDesc = desc;

    const result: SkillMeta = { description: cleanDesc };
    if (triggers.length > 0) result.triggers = triggers;
    return result;
  } catch {
    return {};
  }
}

/**
 * Parse manifest.yaml and extract skill category/description/triggers.
 * F042: manifest is the routing source-of-truth.
 * F228: category moved from BOOTSTRAP.md to manifest.yaml.
 */
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
    // manifest missing or invalid — fallback to SKILL.md metadata
  }
  return result;
}

/**
 * Resolve MCP dependency statuses for all skills that declare requires_mcp.
 */
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
