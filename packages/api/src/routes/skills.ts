/**
 * Skills Route
 * GET /api/skills — Clowder AI 共享 Skills 看板数据
 *
 * 扫描 cat-cafe-skills/ 源目录，检查 Claude/Codex/Gemini/Kimi provider symlink 挂载状态，
 * 解析 BOOTSTRAP.md 提取分类，解析 manifest.yaml 提取触发词。
 */

import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { readCapabilitiesConfig, resolveRequiredMcpStatus } from '../config/capabilities/capability-orchestrator.js';
import { pathsEqual } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
}

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  mounts: SkillMount;
  requiresMcp?: SkillMcpDependency[];
}

interface SkillMcpDependency {
  id: string;
  status: 'ready' | 'missing' | 'unresolved';
}

interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
}

interface SkillsResponse {
  skills: SkillEntry[];
  summary: SkillsSummary;
}

/** Resolve Clowder AI skills source from module location (stable across cwd/project). */
function resolveCatCafeSkillsSourceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return resolve(process.cwd(), 'cat-cafe-skills');
}

const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();

/** Check if a path is a symlink pointing to the expected target. */
async function isCorrectSymlink(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = isAbsolute(dest) ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    const normalizedDest = realDest.replace(/[/\\]$/, '');
    const normalizedExpected = realExpected.replace(/[/\\]$/, '');
    return pathsEqual(normalizedDest, normalizedExpected);
  } catch {
    return false;
  }
}

/** List subdirs that contain SKILL.md */
async function listSkillDirs(skillsSrc: string): Promise<string[]> {
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

interface BootstrapEntry {
  name: string;
  category: string;
  trigger: string;
}

interface SkillMeta {
  description?: string;
  triggers?: string[];
  requiresMcp?: string[];
}

/** Parse BOOTSTRAP.md to extract skill entries with categories and triggers. */
async function parseBootstrap(bootstrapPath: string): Promise<Map<string, BootstrapEntry>> {
  const result = new Map<string, BootstrapEntry>();
  try {
    const content = await readFile(bootstrapPath, 'utf-8');
    const lines = content.split('\n');

    let currentCategory = '';
    for (const line of lines) {
      // Detect category headers: ### 分类名
      const categoryMatch = line.match(/^###\s+(.+)/);
      if (categoryMatch?.[1]) {
        currentCategory = categoryMatch[1].trim();
        continue;
      }
      // Detect skill table rows: | `skill-name` | trigger |
      const rowMatch = line.match(/^\|\s*`([a-z][-a-z0-9]*)`\s*\|\s*(.+?)\s*\|/);
      if (rowMatch?.[1]) {
        const name = rowMatch[1];
        const trigger = rowMatch[2]?.trim() ?? '';
        result.set(name, { name, category: currentCategory, trigger });
      }
    }
  } catch {
    // BOOTSTRAP.md not found or unreadable
  }
  return result;
}

/** Parse manifest.yaml and extract skill description/triggers. */
async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const result = new Map<string, SkillMeta>();
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<string, { description?: unknown; triggers?: unknown; requires_mcp?: unknown }>;
    } | null;
    if (!parsed?.skills || typeof parsed.skills !== 'object') return result;

    for (const [name, meta] of Object.entries(parsed.skills)) {
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
      if (description || (triggers && triggers.length > 0) || (requiresMcp && requiresMcp.length > 0)) {
        result.set(name, {
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

async function resolveSkillMcpStatuses(
  repoRoot: string,
  manifestMeta: Map<string, SkillMeta>,
): Promise<Map<string, SkillMcpDependency>> {
  const capabilities = await readCapabilitiesConfig(repoRoot);
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

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/skills', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    const bootstrapPath = join(skillsSrc, 'BOOTSTRAP.md');
    const home = homedir();

    const catDirs = {
      claude: join(home, '.claude', 'skills'),
      codex: join(home, '.codex', 'skills'),
      gemini: join(home, '.gemini', 'skills'),
      kimi: join(home, '.kimi', 'skills'),
    };

    const [sourceSkills, bootstrapEntries, manifestMeta] = await Promise.all([
      listSkillDirs(skillsSrc),
      parseBootstrap(bootstrapPath),
      parseManifestSkillMeta(skillsSrc),
    ]);
    const mcpStatuses = await resolveSkillMcpStatuses(repoRoot, manifestMeta);

    // Build mount status lookup for each source skill
    const sourceSet = new Set(sourceSkills);
    const mountLookup = new Map<string, SkillEntry>();
    await Promise.all(
      sourceSkills.map(async (name) => {
        const expectedTarget = join(skillsSrc, name);
        const [claude, codex, gemini, kimi] = await Promise.all([
          isCorrectSymlink(join(catDirs.claude, name), expectedTarget),
          isCorrectSymlink(join(catDirs.codex, name), expectedTarget),
          isCorrectSymlink(join(catDirs.gemini, name), expectedTarget),
          isCorrectSymlink(join(catDirs.kimi, name), expectedTarget),
        ]);
        const entry = bootstrapEntries.get(name);
        const meta = manifestMeta.get(name);
        const trigger = meta?.triggers?.length ? meta.triggers.join('、') : (entry?.trigger ?? '');
        mountLookup.set(name, {
          name,
          category: entry?.category ?? '未分类',
          trigger,
          mounts: { claude, codex, gemini, kimi },
          ...(meta?.requiresMcp?.length
            ? {
                requiresMcp: meta.requiresMcp.map((id) => mcpStatuses.get(id) ?? { id, status: 'missing' }),
              }
            : {}),
        });
      }),
    );

    // Order: BOOTSTRAP insertion order first, then unregistered skills appended
    const ordered: string[] = [];
    const bootstrapOrdered = new Set<string>();
    for (const bsName of bootstrapEntries.keys()) {
      if (sourceSet.has(bsName)) {
        ordered.push(bsName);
        bootstrapOrdered.add(bsName);
      }
    }
    for (const name of sourceSkills) {
      if (!bootstrapOrdered.has(name)) ordered.push(name);
    }
    const skills = ordered.map((n) => mountLookup.get(n)!).filter(Boolean);

    // Registration consistency check
    const sourceNames = new Set(sourceSkills);
    const bootstrapNames = new Set(bootstrapEntries.keys());
    const unregistered = sourceSkills.filter((n) => !bootstrapNames.has(n));
    const phantom = [...bootstrapNames].filter((n) => !sourceNames.has(n));
    const registrationConsistent = unregistered.length === 0 && phantom.length === 0;

    const allMounted = skills.every((s) => s.mounts.claude && s.mounts.codex && s.mounts.gemini && s.mounts.kimi);

    const response: SkillsResponse = {
      skills,
      summary: {
        total: skills.length,
        allMounted,
        registrationConsistent,
      },
    };

    return response;
  });
};
