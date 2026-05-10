/**
 * Rules & Prompts Route
 * GET /api/rules — shared rules + provider guides for console transparency
 * GET /api/rules/skill/:name — SKILL.md content preview (allowlisted paths only)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { validateProjectPath } from '../utils/project-path.js';
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

const SHARED_RULE_FILES = ['cat-cafe-skills/refs/shared-rules.md', 'docs/SOP.md'];

const PROVIDER_GUIDE_FILES: Record<string, string> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
};

export const rulesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/rules', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const root = findProjectRoot();
    const [sharedRules, providerGuides] = await Promise.all([
      Promise.all(SHARED_RULE_FILES.map((f) => readRuleFile(root, f))),
      Promise.all(
        Object.entries(PROVIDER_GUIDE_FILES).map(async ([provider, file]) => ({
          provider,
          ...(await readRuleFile(root, file)),
        })),
      ),
    ]);
    return { sharedRules, providerGuides };
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
      const home = homedir();
      const validatedProject = request.query.projectPath ? await validateProjectPath(request.query.projectPath) : null;
      const projectRoot = validatedProject ?? root;
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
      let skillPath: string | null = null;
      for (const dir of candidateDirs) {
        const candidate = join(dir, name, 'SKILL.md');
        if (existsSync(candidate)) {
          skillPath = candidate;
          break;
        }
      }
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
