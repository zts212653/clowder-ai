/**
 * Rules & Prompts Route
 * GET /api/rules — shared rules + provider guides for console transparency
 * GET /api/rules/skill/:name — SKILL.md content preview (allowlisted paths only)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatCafeConfig } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { compileL0ViaSubprocess } from '../domains/cats/services/agents/providers/l0-compiler.js';
import { getDefaultRootsForPlatform, isPathUnderRoots, validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

interface RuleFileResponse {
  path: string;
  content: string;
  exists: boolean;
}

async function readRuleFile(root: string, relativePath: string): Promise<RuleFileResponse> {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) return { path: relativePath, content: '', exists: false };
  try {
    const content = await readFile(fullPath, 'utf-8');
    return { path: relativePath, content, exists: true };
  } catch {
    return { path: relativePath, content: '', exists: false };
  }
}

/**
 * F203 Phase F — L0 system prompt visibility (read-only viewer in Console
 * 「规则与 SOP」). Returns the L0 template + per-cat compiled L0 + paths users
 * follow to customize. Read-only by Design Gate (铲屎官 2026-05-16 confirm
 * "先做可见"; AC-F5 编辑器 DEFER). compileL0 + availableCats injectable for
 * unit tests; route handler passes the real subprocess + cat-catalog.
 */
export interface L0CompiledForCat {
  catId: string;
  displayName: string;
  compiled: string;
  error: string | null;
}

export interface L0PromptsBlock {
  template: RuleFileResponse;
  compiledByCat: L0CompiledForCat[];
  customization: { templatePath: string; compileScript: string; verifyCommand: string };
}

export interface ReadL0PromptsOptions {
  availableCats: Array<{ catId: string; displayName: string }>;
  compileL0: (opts: { catId: string; cwd: string }) => Promise<string>;
}

const L0_TEMPLATE_RELPATH = 'assets/system-prompts/system-prompt-l0.md';
const L0_COMPILE_SCRIPT_RELPATH = 'scripts/compile-system-prompt-l0.mjs';
const L0_VERIFY_COMMAND = 'pnpm gate + runtime restart (KD-5 git revert 回滚通道)';

export async function readL0Prompts(root: string, opts: ReadL0PromptsOptions): Promise<L0PromptsBlock> {
  const template = await readRuleFile(root, L0_TEMPLATE_RELPATH);
  const compiledByCat: L0CompiledForCat[] = await Promise.all(
    opts.availableCats.map(async ({ catId, displayName }) => {
      try {
        const compiled = await opts.compileL0({ catId, cwd: root });
        return { catId, displayName, compiled, error: null };
      } catch (e) {
        return { catId, displayName, compiled: '', error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return {
    template,
    compiledByCat,
    customization: {
      templatePath: L0_TEMPLATE_RELPATH,
      compileScript: L0_COMPILE_SCRIPT_RELPATH,
      verifyCommand: L0_VERIFY_COMMAND,
    },
  };
}

/**
 * Resolve enabled cats from the runtime loader's merged template+catalog
 * source (no-arg `loadCatConfig()` per KD-13 / SystemPromptBuilder pattern).
 * Hardcoding the catalog file silently returned [] on bootstrap-empty —
 * cloud P1 R1 on PR #1717. The bare try/catch then swallowed real config
 * errors (malformed template / schema regression) → silent 0 cats masked
 * operator-actionable bugs — cloud P2 R2. The no-arg loader handles the
 * one expected "catalog absent" case internally (template defaults), so
 * any error from it is a real configuration failure that MUST propagate.
 * `loaderFn` is injectable for tests.
 */
export function loadAvailableCatsForL0(
  loaderFn: () => CatCafeConfig = loadCatConfig,
): Array<{ catId: string; displayName: string }> {
  const config = loaderFn();
  const allCats = toAllCatConfigs(config);
  const roster = getRoster(config);
  return Object.entries(allCats)
    .filter(([catId]) => roster[catId]?.available !== false)
    .map(([catId, c]) => ({ catId, displayName: c.displayName ?? catId }));
}

const SHARED_RULE_FILES = ['cat-cafe-skills/refs/shared-rules.md', 'docs/SOP.md'];

const PROVIDER_GUIDE_FILES: Record<string, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
};

export function isLegacySkillProjectPath(absPath: string, roots: string[] = getDefaultRootsForPlatform()): boolean {
  return isPathUnderRoots(
    resolve(absPath),
    roots.map((root) => resolve(root)),
  );
}

async function findSkillPath(root: string, name: string, projectPath?: string): Promise<string | null> {
  const home = homedir();
  const validatedProject = projectPath ? await validateProjectPath(projectPath) : null;
  const projectRoot = validatedProject && isLegacySkillProjectPath(validatedProject) ? validatedProject : root;
  const candidateDirs = [
    join(root, 'cat-cafe-skills'),
    join(projectRoot, '.claude', 'skills'),
    join(home, '.claude', 'skills'),
    join(projectRoot, '.codex', 'skills'),
    join(home, '.codex', 'skills'),
    join(projectRoot, '.gemini', 'skills'),
    join(home, '.gemini', 'skills'),
    join(projectRoot, '.kimi', 'skills'),
    join(home, '.kimi', 'skills'),
  ];
  for (const dir of candidateDirs) {
    const candidate = join(dir, name, 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const rulesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/rules', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const root = findProjectRoot();
    const availableCats = loadAvailableCatsForL0();
    const [sharedRules, providerGuides, l0Prompts] = await Promise.all([
      Promise.all(SHARED_RULE_FILES.map((f) => readRuleFile(root, f))),
      Promise.all(
        Object.entries(PROVIDER_GUIDE_FILES).map(async ([provider, file]) => ({
          provider,
          ...(await readRuleFile(root, file)),
        })),
      ),
      readL0Prompts(root, { availableCats, compileL0: compileL0ViaSubprocess }),
    ]);
    return { sharedRules, providerGuides, l0Prompts };
  });

  app.get<{ Params: { name: string }; Querystring: { projectPath?: string } }>(
    '/api/rules/skill/:name',
    async (request, reply) => {
      if (!resolveUserId(request)) {
        reply.status(401);
        return { error: 'Authentication required' };
      }
      const { name } = request.params;
      if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
        reply.status(400);
        return { error: 'Invalid skill name' };
      }
      const root = findProjectRoot();
      const skillPath = await findSkillPath(root, name, request.query.projectPath);
      if (!skillPath) {
        reply.status(404);
        return { error: `Skill "${name}" not found` };
      }
      try {
        const content = await readFile(skillPath, 'utf-8');
        return { name, content, path: skillPath };
      } catch {
        reply.status(500);
        return { error: 'Failed to read skill content' };
      }
    },
  );
};
