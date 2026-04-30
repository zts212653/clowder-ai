/**
 * Rules & Prompts Route
 * GET /api/rules — shared rules + provider guides for console transparency
 * GET /api/rules/skill/:name — SKILL.md content preview (allowlisted paths only)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';

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
  app.get('/api/rules', async () => {
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

  app.get<{ Params: { name: string } }>('/api/rules/skill/:name', async (request, reply) => {
    const { name } = request.params;
    if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
      reply.status(400);
      return { error: 'Invalid skill name' };
    }
    const root = findProjectRoot();
    const skillPath = join(root, 'cat-cafe-skills', name, 'SKILL.md');
    if (!existsSync(skillPath)) {
      reply.status(404);
      return { error: `Skill "${name}" not found` };
    }
    try {
      const content = await readFile(skillPath, 'utf-8');
      return { name, content };
    } catch {
      reply.status(500);
      return { error: 'Failed to read skill content' };
    }
  });
};
