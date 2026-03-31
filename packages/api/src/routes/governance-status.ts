/**
 * F113 Phase E: GET /api/governance/status
 * Query governance readiness for a project path.
 * Reuses checkGovernancePreflight() and adds isEmptyDir / isGitRepo / gitAvailable.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { checkGovernancePreflight } from '../config/governance/governance-preflight.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const execFileAsync = promisify(execFile);

async function isEmptyDir(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    // .git can be a directory (normal repo) or a file (worktree: "gitdir: ...")
    await stat(join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

let gitAvailableCache: boolean | null = null;

async function checkGitAvailable(): Promise<boolean> {
  if (gitAvailableCache !== null) return gitAvailableCache;
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000 });
    gitAvailableCache = true;
  } catch {
    gitAvailableCache = false;
  }
  return gitAvailableCache;
}

export const governanceStatusRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/governance/status', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const query = request.query as { projectPath?: string };
    if (!query.projectPath) {
      reply.status(400);
      return { error: 'projectPath parameter is required' };
    }

    const validated = await validateProjectPath(query.projectPath);
    if (!validated) {
      reply.status(403);
      return { error: 'Project path not allowed' };
    }

    const catCafeRoot = findMonorepoRoot(process.cwd());
    const preflight = await checkGovernancePreflight(validated, catCafeRoot);

    const [empty, gitRepo, gitOk] = await Promise.all([
      isEmptyDir(validated),
      isGitRepo(validated),
      checkGitAvailable(),
    ]);

    return {
      ready: preflight.ready,
      needsBootstrap: preflight.needsBootstrap ?? false,
      needsConfirmation: preflight.needsConfirmation ?? false,
      isEmptyDir: empty,
      isGitRepo: gitRepo,
      gitAvailable: gitOk,
    };
  });
};
