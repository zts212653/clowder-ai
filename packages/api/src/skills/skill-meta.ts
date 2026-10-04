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
import type { CapabilitiesConfig } from '@cat-cafe/shared';
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
  const state = await readSkillMetaState(skillDir);
  return state.kind === 'present' ? state.meta : {};
}

/**
 * What reading a skill's metadata found. Unlike `readSkillMeta` (which answers
 * `{}` for every failure), a file that exists but cannot be read or parsed is
 * `unreadable`, not "this skill has no description".
 */
export type SkillMetaReadState =
  | { readonly kind: 'present'; readonly meta: SkillMeta }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly errno?: string };

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

export async function readSkillMetaState(skillDir: string): Promise<SkillMetaReadState> {
  const skillMdPath = join(skillDir, 'SKILL.md');
  let content: string;
  try {
    content = await readFile(skillMdPath, 'utf-8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errno && ABSENT_CODES.has(errno)) return { kind: 'absent' };
    return { kind: 'unreadable', path: skillMdPath, ...(errno ? { errno } : {}) };
  }
  try {
    return { kind: 'present', meta: parseSkillMetaContent(content) };
  } catch {
    return { kind: 'unreadable', path: skillMdPath, errno: 'EPARSE' };
  }
}

function parseSkillMetaContent(content: string): SkillMeta {
  {
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
  }
}

/**
 * Parse manifest.yaml and extract skill category/description/triggers.
 * F042: manifest is the routing source-of-truth.
 * F228: category moved from BOOTSTRAP.md to manifest.yaml.
 */
export async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const state = await parseManifestSkillMetaState(skillsSrcDir);
  return state.kind === 'present' ? state.meta : new Map();
}

/** As `readSkillMetaState`, for the manifest: missing ≠ present-but-unreadable. */
export type ManifestMetaReadState =
  | { readonly kind: 'present'; readonly meta: Map<string, SkillMeta> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly path: string; readonly errno?: string };

export async function parseManifestSkillMetaState(skillsSrcDir: string): Promise<ManifestMetaReadState> {
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errno && ABSENT_CODES.has(errno)) return { kind: 'absent' };
    return { kind: 'unreadable', path: manifestPath, ...(errno ? { errno } : {}) };
  }
  try {
    return { kind: 'present', meta: parseManifestContent(content) };
  } catch {
    return { kind: 'unreadable', path: manifestPath, errno: 'EPARSE' };
  }
}

function parseManifestContent(content: string): Map<string, SkillMeta> {
  const result = new Map<string, SkillMeta>();
  {
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
  }
  return result;
}

/**
 * Resolve MCP dependency statuses for all skills that declare requires_mcp.
 */
export async function resolveSkillMcpStatuses(
  projectRoot: string,
  manifestMeta: Map<string, SkillMeta>,
  /**
   * The config the caller already read. Passing it keeps these statuses on the
   * same bytes as the rest of the caller's answer, not on a second read that may
   * see a different file.
   */
  loadedConfig?: CapabilitiesConfig | null,
): Promise<Map<string, SkillMcpDependency>> {
  const capabilities = loadedConfig !== undefined ? loadedConfig : await readCapabilitiesConfig(projectRoot);
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
