/**
 * Skills Route
 * GET  /api/skills          — Clowder AI 共享 Skills 看板数据
 * GET  /api/skills/search   — 搜索 SkillHub 远程 skill
 * GET  /api/skills/trending — 获取热门 skill
 * GET  /api/skills/preview  — 预览远程 skill SKILL.md 内容
 * POST /api/skills/install  — 安装远程 skill
 * POST /api/skills/uninstall — 卸载远程 skill
 */

import { existsSync } from 'node:fs';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { parseSkillFrontmatter } from '../domains/cats/services/skillhub/frontmatter-parser.js';
import { loadInstalledRegistry } from '../domains/cats/services/skillhub/InstalledSkillRegistry.js';
import { fetchSkillContent, searchSkills, trendingSkills } from '../domains/cats/services/skillhub/SkillHubService.js';
import {
  getInstalledRecords,
  installSkill,
  SkillInstallError,
  uninstallSkill,
} from '../domains/cats/services/skillhub/SkillInstallManager.js';
import { resolveUserId } from '../utils/request-identity.js';

interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  source: 'local' | 'skillhub';
  skillhubUrl?: string;
  mounts: SkillMount;
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
const CAT_CAFE_ROOT = dirname(CAT_CAFE_SKILLS_SRC);

async function isCorrectSymlink(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = dest.startsWith('/') ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    return realDest.replace(/\/$/, '') === realExpected.replace(/\/$/, '');
  } catch {
    return false;
  }
}

async function listSkillDirs(skillsSrc: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(skillsSrc, { withFileTypes: true });
    const names: string[] = [];
    for (const e of dirs) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      try {
        await readFile(join(skillsSrc, e.name, 'SKILL.md'), 'utf-8');
        names.push(e.name);
      } catch {
        // skip
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
}

async function parseBootstrap(bootstrapPath: string): Promise<Map<string, BootstrapEntry>> {
  const result = new Map<string, BootstrapEntry>();
  try {
    const content = await readFile(bootstrapPath, 'utf-8');
    const lines = content.split('\n');
    let currentCategory = '';
    for (const line of lines) {
      const categoryMatch = line.match(/^###\s+(.+)/);
      if (categoryMatch?.[1]) {
        currentCategory = categoryMatch[1].trim();
        continue;
      }
      const rowMatch = line.match(/^\|\s*`([a-z][-a-z0-9_]*)`\s*\|\s*(.+?)\s*\|/);
      if (rowMatch?.[1]) {
        result.set(rowMatch[1], { name: rowMatch[1], category: currentCategory, trigger: rowMatch[2]?.trim() ?? '' });
      }
    }
  } catch {
    // not found
  }
  return result;
}

async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const result = new Map<string, SkillMeta>();
  try {
    const content = await readFile(join(skillsSrcDir, 'manifest.yaml'), 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<string, { description?: unknown; triggers?: unknown }>;
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
      if (description || (triggers && triggers.length > 0)) {
        result.set(name, { ...(description ? { description } : {}), ...(triggers?.length ? { triggers } : {}) });
      }
    }
  } catch {
    // skip
  }
  return result;
}

async function getBootstrapNames(skillsSrcDir: string): Promise<Set<string>> {
  return new Set((await parseBootstrap(join(skillsSrcDir, 'BOOTSTRAP.md'))).keys());
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  // ────────────────────────────────────────────────────────
  // GET /api/skills
  // ────────────────────────────────────────────────────────
  app.get('/api/skills', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const [sourceSkills, bootstrapEntries, manifestMeta, installedRecords] = await Promise.all([
      listSkillDirs(CAT_CAFE_SKILLS_SRC),
      parseBootstrap(join(CAT_CAFE_SKILLS_SRC, 'BOOTSTRAP.md')),
      parseManifestSkillMeta(CAT_CAFE_SKILLS_SRC),
      getInstalledRecords(CAT_CAFE_ROOT),
    ]);

    const installedNameSet = new Set(installedRecords.map((r) => r.name));
    const installedRecordMap = new Map(installedRecords.map((r) => [r.name, r]));
    const home = homedir();
    const catDirs = {
      claude: join(home, '.claude', 'skills'),
      codex: join(home, '.codex', 'skills'),
      gemini: join(home, '.gemini', 'skills'),
    };

    const sourceSet = new Set(sourceSkills);
    const mountLookup = new Map<string, SkillEntry>();

    await Promise.all(
      sourceSkills.map(async (name) => {
        const expectedTarget = join(CAT_CAFE_SKILLS_SRC, name);
        const [claude, codex, gemini] = await Promise.all([
          isCorrectSymlink(join(catDirs.claude, name), expectedTarget),
          isCorrectSymlink(join(catDirs.codex, name), expectedTarget),
          isCorrectSymlink(join(catDirs.gemini, name), expectedTarget),
        ]);

        const isRemote = installedNameSet.has(name);
        const entry = bootstrapEntries.get(name);
        const meta = manifestMeta.get(name);

        let trigger = '';
        let category = entry?.category ?? '未分类';
        let source: 'local' | 'skillhub' = 'local';
        let skillhubUrl: string | undefined;

        if (isRemote) {
          const frontmatter = await parseSkillFrontmatter(join(CAT_CAFE_SKILLS_SRC, name));
          trigger = frontmatter.triggers?.join('、') ?? '';
          category = 'SkillHub';
          source = 'skillhub';
          skillhubUrl = installedRecordMap.get(name)?.skillhubUrl;
        } else {
          trigger = meta?.triggers?.length ? meta.triggers.join('、') : (entry?.trigger ?? '');
        }

        mountLookup.set(name, { name, category, trigger, source, skillhubUrl, mounts: { claude, codex, gemini } });
      }),
    );

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

    const bootstrapNames = new Set(bootstrapEntries.keys());
    const unregistered = sourceSkills.filter((n) => !bootstrapNames.has(n) && !installedNameSet.has(n));
    const phantom = [...bootstrapNames].filter((n) => !sourceSet.has(n));
    const registrationConsistent = unregistered.length === 0 && phantom.length === 0;

    const localSkills = skills.filter((s) => s.source === 'local');
    const allMounted =
      localSkills.length === 0 || localSkills.every((s) => s.mounts.claude && s.mounts.codex && s.mounts.gemini);

    return { skills, summary: { total: skills.length, allMounted, registrationConsistent } } satisfies SkillsResponse;
  });

  // ────────────────────────────────────────────────────────
  // GET /api/skills/search
  // ────────────────────────────────────────────────────────
  app.get('/api/skills/search', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const query = (request.query as { q?: string }).q;
    if (!query) {
      reply.status(400);
      return { error: 'Missing required query parameter: q' };
    }

    const page = Number((request.query as { page?: string }).page) || 1;
    const limit = Number((request.query as { limit?: string }).limit) || 20;

    try {
      const result = await searchSkills(query, { page, limit });
      const installedNames = new Set((await getInstalledRecords(CAT_CAFE_ROOT)).map((r) => r.name));
      return {
        skills: result.data.map((s) => ({ ...s, isInstalled: installedNames.has(s.slug) })),
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch (err) {
      reply.status(502);
      return { error: `SkillHub unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/skills/trending
  // ────────────────────────────────────────────────────────
  app.get('/api/skills/trending', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    try {
      const result = await trendingSkills();
      const installedNames = new Set((await getInstalledRecords(CAT_CAFE_ROOT)).map((r) => r.name));
      return {
        skills: result.data.map((s) => ({ ...s, isInstalled: installedNames.has(s.slug) })),
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
      };
    } catch (err) {
      reply.status(502);
      return { error: `SkillHub unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ────────────────────────────────────────────────────────
  // GET /api/skills/preview
  // ────────────────────────────────────────────────────────
  app.get('/api/skills/preview', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const q = request.query as { owner?: string; repo?: string; skill?: string };
    if (!q.owner || !q.repo || !q.skill) {
      reply.status(400);
      return { error: 'Missing: owner, repo, skill' };
    }

    try {
      const content = await fetchSkillContent(q.owner, q.repo, q.skill);
      return { content, owner: q.owner, repo: q.repo, skill: q.skill };
    } catch (err) {
      reply.status(502);
      return { error: `Failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/skills/install
  // ────────────────────────────────────────────────────────
  app.post('/api/skills/install', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = request.body as { owner?: string; repo?: string; skill?: string; localName?: string };
    if (!body.owner || !body.repo || !body.skill) {
      reply.status(400);
      return { error: 'Missing: owner, repo, skill' };
    }

    try {
      return await installSkill(CAT_CAFE_ROOT, {
        owner: body.owner,
        repo: body.repo,
        skill: body.skill,
        localName: body.localName,
      });
    } catch (err) {
      if (err instanceof SkillInstallError) {
        const map: Record<string, number> = {
          CONFLICT: 409,
          VALIDATION: 422,
          NOT_FOUND: 404,
          FORBIDDEN: 403,
          DOWNLOAD: 502,
        };
        reply.status(map[err.code] ?? 500);
        return { success: false, error: err.message, code: err.code };
      }
      reply.status(500);
      return { success: false, error: String(err) };
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/skills/uninstall
  // ────────────────────────────────────────────────────────
  app.post('/api/skills/uninstall', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = request.body as { name?: string };
    if (!body.name) {
      reply.status(400);
      return { error: 'Missing: name' };
    }

    try {
      const bootstrapNames = await getBootstrapNames(CAT_CAFE_SKILLS_SRC);
      await uninstallSkill(CAT_CAFE_ROOT, body.name, bootstrapNames);
      return { success: true, name: body.name };
    } catch (err) {
      if (err instanceof SkillInstallError) {
        const map: Record<string, number> = {
          CONFLICT: 409,
          VALIDATION: 422,
          NOT_FOUND: 404,
          FORBIDDEN: 403,
          DOWNLOAD: 502,
        };
        reply.status(map[err.code] ?? 500);
        return { success: false, error: err.message, code: err.code };
      }
      reply.status(500);
      return { success: false, error: String(err) };
    }
  });
};
