/**
 * F113 Phase E: POST /api/projects/setup
 * Orchestrates project initialization: clone/init git + governance bootstrap.
 * Does NOT modify governance/confirm semantics — calls it internally.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const VALID_MODES = ['clone', 'init', 'skip'] as const;
type SetupMode = (typeof VALID_MODES)[number];

/** Only allow https:// and git@ URLs */
const SAFE_URL_PATTERN = /^(https:\/\/|git@)/;

/** Clone timeout in ms */
const CLONE_TIMEOUT_MS = 120_000;

interface CloneResult {
  ok: boolean;
  errorKind?: 'auth_failed' | 'network_error' | 'not_found' | 'timeout' | 'unknown';
  error?: string;
}

function classifyGitError(exitCode: number | null, stderr: string, killed: boolean): CloneResult {
  if (killed) return { ok: false, errorKind: 'timeout', error: 'Git clone timed out (120s)' };
  const lc = stderr.toLowerCase();
  if (exitCode === 128) {
    if (lc.includes('authentication') || lc.includes('could not read') || lc.includes('permission denied')) {
      return { ok: false, errorKind: 'auth_failed', error: 'Authentication failed' };
    }
    if (lc.includes('not found') || lc.includes('does not exist') || lc.includes('repository')) {
      return { ok: false, errorKind: 'not_found', error: 'Repository not found' };
    }
  }
  if (lc.includes('unable to access') || lc.includes('could not resolve')) {
    return { ok: false, errorKind: 'network_error', error: 'Network error' };
  }
  return { ok: false, errorKind: 'unknown', error: stderr.slice(0, 500) || 'Clone failed' };
}

async function gitClone(url: string, targetPath: string): Promise<CloneResult> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CLONE_TIMEOUT_MS);
    const child = execFile(
      'git',
      ['clone', url, '.'],
      {
        cwd: targetPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        signal: ac.signal,
        timeout: CLONE_TIMEOUT_MS,
      },
      (err, _stdout, stderr) => {
        clearTimeout(timer);
        if (!err) return resolve({ ok: true });
        const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const numericExit = typeof exitCode === 'number' ? exitCode : null;
        const killed = (err as { killed?: boolean }).killed ?? false;
        resolve(classifyGitError(numericExit, stderr, killed));
      },
    );
    // Extra safety: kill on abort
    ac.signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  });
}

async function gitInit(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['init'], { cwd: targetPath, timeout: 10_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function isEmptyDir(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export const projectSetupRoute: FastifyPluginAsync = async (app) => {
  app.post('/api/projects/setup', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const body = request.body as {
      projectPath?: string;
      mode?: string;
      gitCloneUrl?: string;
    } | null;

    const projectPath = body?.projectPath;
    const mode = body?.mode as SetupMode | undefined;
    const gitCloneUrl = body?.gitCloneUrl;

    if (!projectPath) {
      reply.status(400);
      return { error: 'projectPath is required' };
    }

    if (!mode || !VALID_MODES.includes(mode)) {
      reply.status(400);
      return { error: `mode must be one of: ${VALID_MODES.join(', ')}` };
    }

    const validated = await validateProjectPath(projectPath);
    if (!validated) {
      reply.status(403);
      return { error: 'Project path not allowed' };
    }

    // Guard: never bootstrap Cat Cafe's own directory (same as governance/confirm)
    const catCafeRoot = findMonorepoRoot(process.cwd());
    if (validated === catCafeRoot) {
      reply.status(400);
      return { error: 'Cannot setup governance for Cat Cafe itself' };
    }

    // ── Mode: clone ──
    if (mode === 'clone') {
      if (!gitCloneUrl) {
        reply.status(400);
        return { error: 'gitCloneUrl is required when mode=clone' };
      }
      if (!SAFE_URL_PATTERN.test(gitCloneUrl)) {
        reply.status(400);
        return { error: 'Only https:// and git@ URLs are allowed' };
      }
      if (!(await isEmptyDir(validated))) {
        reply.status(409);
        return {
          ok: false,
          errorKind: 'not_empty',
          error: 'Directory is not empty. Clone requires an empty directory.',
        };
      }
      const result = await gitClone(gitCloneUrl, validated);
      if (!result.ok) {
        reply.status(502);
        return { ok: false, errorKind: result.errorKind, error: result.error };
      }
    }

    // ── Mode: init ──
    if (mode === 'init') {
      // Check if already a git repo (.git can be dir or file in worktrees)
      try {
        await stat(join(validated, '.git'));
        // Already initialized — skip git init, still run governance
      } catch {
        await gitInit(validated);
      }
    }

    // ── Governance bootstrap (all modes) ──
    try {
      const { GovernanceBootstrapService } = await import('../config/governance/governance-bootstrap.js');
      const service = new GovernanceBootstrapService(catCafeRoot);
      const report = await service.bootstrap(validated, { dryRun: false });
      return { ok: true, governanceReport: report };
    } catch (err) {
      reply.status(500);
      return { ok: false, error: err instanceof Error ? err.message : 'Governance bootstrap failed' };
    }
  });
};
