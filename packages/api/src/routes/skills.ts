/**
 * Skills Route
 * GET /api/skills — Clowder AI 共享 Skills 看板数据 + staleness/conflicts (ADR-025 Phase 2)
 * POST /api/skills/sync — Re-sync managed symlinks
 * POST /api/skills/resolve-conflict — Resolve user/project skill conflict
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import type { SkillConflict } from '../config/governance/skill-conflict.js';
import { detectConflicts } from '../config/governance/skill-conflict.js';
import { resolveConflict, syncSkills, validateSkillName } from '../config/governance/skill-sync.js';
import type { SkillsStaleness } from '../config/governance/skills-state.js';
import { checkStaleness, readSkillsState } from '../config/governance/skills-state.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import {
  buildProviderSkillDirCandidates,
  isSkillMountedForProvider,
  resolveMainRepoPath,
} from '../utils/skill-mount.js';
import {
  listSkillDirs,
  parseBootstrap,
  parseManifestSkillMeta,
  resolveSkillMcpStatuses,
  type SkillMcpDependency,
} from '../utils/skill-parse.js';

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

interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
}

interface SkillsResponse {
  skills: SkillEntry[];
  summary: SkillsSummary;
  staleness: SkillsStaleness | null;
  conflicts: SkillConflict[];
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

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/skills', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    const bootstrapPath = join(skillsSrc, 'BOOTSTRAP.md');
    const query = request.query as { projectPath?: string };
    let projectRoot = repoRoot;
    if (query.projectPath) {
      const validated = await validateProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }
    const home = homedir();
    const providerDirCandidates = buildProviderSkillDirCandidates(projectRoot, home);
    const mainRepo = await resolveMainRepoPath();
    const mainSkillsSrc = join(mainRepo, 'cat-cafe-skills');

    const [sourceSkills, bootstrapEntries, manifestMeta] = await Promise.all([
      listSkillDirs(skillsSrc),
      parseBootstrap(bootstrapPath),
      parseManifestSkillMeta(skillsSrc),
    ]);
    const mcpStatuses = await resolveSkillMcpStatuses(projectRoot, manifestMeta);

    // Build mount status lookup for each source skill
    const sourceSet = new Set(sourceSkills);
    const mountLookup = new Map<string, SkillEntry>();
    await Promise.all(
      sourceSkills.map(async (name) => {
        const [claude, codex, gemini, kimi] = await Promise.all([
          isSkillMountedForProvider(providerDirCandidates.claude, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.codex, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.gemini, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.kimi, skillsSrc, name, mainSkillsSrc),
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

    // ADR-025 Phase 2: staleness + conflicts
    const state = await readSkillsState(projectRoot);
    const managedNames = state?.managedSkillNames ?? sourceSkills;
    const [staleness, conflicts] = await Promise.all([
      checkStaleness(projectRoot, skillsSrc),
      detectConflicts(projectRoot, home, managedNames),
    ]);

    const response: SkillsResponse = {
      skills,
      summary: { total: skills.length, allMounted, registrationConsistent },
      staleness,
      conflicts,
    };

    return response;
  });

  app.post('/api/skills/sync', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as { projectPath?: string };
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const result = await syncSkills(projectRoot, skillsSrc);
    return result;
  });

  app.post('/api/skills/resolve-conflict', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as {
      skillName?: string;
      choice?: 'official' | 'mine';
      projectPath?: string;
    };
    if (!body.skillName || !body.choice) {
      reply.status(400);
      return { error: 'skillName and choice are required' };
    }
    if (body.choice !== 'official' && body.choice !== 'mine') {
      reply.status(400);
      return { error: "choice must be 'official' or 'mine'" };
    }
    try {
      validateSkillName(body.skillName);
    } catch {
      reply.status(400);
      return { error: 'Invalid skill name: must be lowercase letters, digits, and hyphens' };
    }
    const repoRoot = dirname(CAT_CAFE_SKILLS_SRC);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    await resolveConflict(projectRoot, homedir(), body.skillName, body.choice);
    return { ok: true, skillName: body.skillName, choice: body.choice };
  });
};
