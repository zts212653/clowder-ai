/**
 * Workspace Git Routes — F082 Git Health Panel
 *
 * GET  /api/workspace/git-log     — commit history
 * GET  /api/workspace/git-status  — working tree status (staged/unstaged/untracked)
 * GET  /api/workspace/git-show    — single commit changed-file summary
 * GET  /api/workspace/git-health  — stale branches, orphan worktrees, runtime drift
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { getWorktreeRoot, WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';

const execFileAsync = promisify(execFile);

// ── Parsers (exported for unit testing) ─────────────────────────────

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export function parseGitLog(stdout: string): GitCommit[] {
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [hash = '', author = '', date = '', ...subjectParts] = line.split('\0');
      return { hash, short: hash.slice(0, 8), author, date, subject: subjectParts.join('\0') };
    });
}

export interface GitStatusResult {
  staged: Array<{ status: string; path: string }>;
  unstaged: Array<{ status: string; path: string }>;
  untracked: Array<{ status: string; path: string }>;
}

function classifyStatusLine(
  line: string,
): { category: 'staged' | 'unstaged' | 'untracked'; status: string; path: string }[] {
  if (line.length < 4) return [];
  const x = line[0] ?? ' ';
  const y = line[1] ?? ' ';
  const filePath = line.slice(3);
  if (x === '?' && y === '?') return [{ category: 'untracked', status: '??', path: filePath }];
  const entries: { category: 'staged' | 'unstaged'; status: string; path: string }[] = [];
  if (x !== ' ' && x !== '?') entries.push({ category: 'staged', status: x, path: filePath });
  if (y !== ' ' && y !== '?') entries.push({ category: 'unstaged', status: y, path: filePath });
  return entries;
}

export function parseGitStatus(stdout: string): GitStatusResult {
  const result: GitStatusResult = { staged: [], unstaged: [], untracked: [] };
  if (!stdout.trim()) return result;
  for (const line of stdout.trim().split('\n')) {
    for (const entry of classifyStatusLine(line)) {
      result[entry.category].push({ status: entry.status, path: entry.path });
    }
  }
  return result;
}

export function parseGitShow(statOutput: string): Array<{ path: string; summary: string }> {
  return statOutput
    .trim()
    .split('\n')
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [pathPart, ...rest] = l.split('|');
      return { path: (pathPart ?? '').trim(), summary: rest.join('|').trim() };
    });
}

// ── Phase 2: Health Dashboard Parsers ────────────────────────────────

export interface StaleBranch {
  name: string;
  lastCommitDate: string;
  author: string;
  mergedInto: string;
}

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop']);

export function parseStaleBranches(stdout: string): StaleBranch[] {
  if (!stdout.trim()) return [];
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const clean = line.replace(/^\*\s*/, '').trim();
      const [name = '', lastCommitDate = '', author = ''] = clean.split('\x00');
      return { name: name.trim(), lastCommitDate, author, mergedInto: 'main' };
    })
    .filter((b) => b.name && !PROTECTED_BRANCHES.has(b.name));
}

export interface WorktreeHealthEntry {
  path: string;
  branch: string;
  head: string;
  isOrphan: boolean;
}

function applyWorktreeLine(line: string, current: Partial<WorktreeHealthEntry>): void {
  if (line.startsWith('worktree ')) current.path = line.slice(9);
  else if (line.startsWith('HEAD ')) current.head = line.slice(5, 13);
  else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
  else if (line === 'detached') current.branch = '(detached)';
}

export function parseWorktreeHealth(porcelainOutput: string, mergedBranches: Set<string>): WorktreeHealthEntry[] {
  const entries: WorktreeHealthEntry[] = [];
  let current: Partial<WorktreeHealthEntry> = {};
  for (const line of porcelainOutput.split('\n')) {
    if (line === '' && current.path) {
      entries.push({
        path: current.path,
        branch: current.branch ?? '(unknown)',
        head: current.head ?? '',
        isOrphan: current.branch ? mergedBranches.has(current.branch) : false,
      });
      current = {};
    } else {
      applyWorktreeLine(line, current);
    }
  }
  return entries;
}

export interface DriftCommit {
  short: string;
  subject: string;
}

export interface RuntimeDrift {
  available: boolean;
  aheadOfMain: number;
  behindMain: number;
  runtimeHead: string;
  mainHead: string;
  behindCommits: DriftCommit[];
}

export function parseDriftCommits(logOutput: string): DriftCommit[] {
  if (!logOutput.trim()) return [];
  return logOutput
    .trim()
    .split('\n')
    .map((line) => {
      const [short = '', ...rest] = line.split(' ');
      return { short, subject: rest.join(' ') };
    });
}

export function parseRuntimeDrift(
  revListOutput: string,
  mainHead: string,
  runtimeHead: string,
  behindCommits: DriftCommit[] = [],
): RuntimeDrift {
  const [left = '0', right = '0'] = revListOutput.trim().split('\t');
  return {
    available: true,
    behindMain: Number(left) || 0,
    aheadOfMain: Number(right) || 0,
    mainHead,
    runtimeHead,
    behindCommits,
  };
}

async function detectRuntimeDrift(repoRoot: string): Promise<RuntimeDrift | null> {
  const runtimePath = process.env.RUNTIME_REPO_PATH;
  if (!runtimePath) return null;
  try {
    // Always compare against main, not HEAD — HEAD varies per worktree (VG-1 P1 fix)
    const mainBranch = 'refs/heads/main';
    const { stdout: mainRef } = await execFileAsync('git', ['rev-parse', '--short', mainBranch], {
      cwd: repoRoot,
      timeout: 3000,
    });
    const { stdout: rtRef } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: runtimePath,
      timeout: 3000,
    });
    const { stdout: drift } = await execFileAsync(
      'git',
      ['rev-list', '--left-right', '--count', `${mainBranch}...${rtRef.trim()}`],
      { cwd: repoRoot, timeout: 5000 },
    );
    // Fetch commits that main has but runtime doesn't (behind commits)
    const { stdout: logOut } = await execFileAsync(
      'git',
      ['log', '--oneline', '-n', '20', `${rtRef.trim()}..${mainBranch}`],
      { cwd: repoRoot, timeout: 5000 },
    );
    const behindCommits = parseDriftCommits(logOut);
    return parseRuntimeDrift(drift, mainRef.trim(), rtRef.trim(), behindCommits);
  } catch {
    return { available: false, aheadOfMain: 0, behindMain: 0, runtimeHead: '', mainHead: '', behindCommits: [] };
  }
}

// ── Routes ──────────────────────────────────────────────────────────

export const workspaceGitRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/workspace/git-log
  app.get<{
    Querystring: { worktreeId?: string; limit?: string };
  }>('/api/workspace/git-log', async (request, reply) => {
    const { worktreeId, limit = '50' } = request.query;
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const n = Math.min(Math.max(1, Number(limit) || 50), 200);
      const { stdout } = await execFileAsync(
        'git',
        ['log', '-n', String(n), '--pretty=format:%H%x00%an%x00%aI%x00%s'],
        {
          cwd: root,
          timeout: 5000,
        },
      );
      return { worktreeId, commits: parseGitLog(stdout) };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      throw e;
    }
  });

  // GET /api/workspace/git-status
  app.get<{
    Querystring: { worktreeId?: string };
  }>('/api/workspace/git-status', async (request, reply) => {
    const { worktreeId } = request.query;
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
        cwd: root,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      });
      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: root,
        timeout: 3000,
      });
      return { worktreeId, branch: branchOut.trim(), ...parseGitStatus(stdout) };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      throw e;
    }
  });

  // GET /api/workspace/git-show
  app.get<{
    Querystring: { worktreeId?: string; hash?: string };
  }>('/api/workspace/git-show', async (request, reply) => {
    const { worktreeId, hash } = request.query;
    if (!worktreeId || !hash) {
      reply.status(400);
      return { error: 'worktreeId and hash required' };
    }
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      reply.status(400);
      return { error: 'invalid hash' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);
      const { stdout } = await execFileAsync('git', ['show', '--stat', '--no-color', hash], {
        cwd: root,
        timeout: 5000,
      });
      const parts = stdout.split('\n\n');
      const statSection = parts.length > 1 ? parts.slice(1).join('\n\n') : '';
      return { worktreeId, hash, files: parseGitShow(statSection) };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      throw e;
    }
  });

  // GET /api/workspace/git-health (Phase 2)
  app.get<{
    Querystring: { worktreeId?: string };
  }>('/api/workspace/git-health', async (request, reply) => {
    const { worktreeId } = request.query;
    if (!worktreeId) {
      reply.status(400);
      return { error: 'worktreeId required' };
    }
    try {
      const root = await getWorktreeRoot(worktreeId);

      // 1. Stale branches: merged into main but not deleted
      const { stdout: mergedOut } = await execFileAsync(
        'git',
        ['branch', '--merged', 'main', '--format=%(refname:short)%x00%(committerdate:iso-strict)%x00%(authorname)'],
        { cwd: root, timeout: 5000 },
      );
      const staleBranches = parseStaleBranches(mergedOut);

      // 2. Worktree health
      const mergedNames = new Set(staleBranches.map((b) => b.name));
      const { stdout: wtOut } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: root,
        timeout: 5000,
      });
      const worktrees = parseWorktreeHealth(wtOut, mergedNames);

      // 3. Runtime drift (optional — needs RUNTIME_REPO_PATH env)
      const runtimeDrift = await detectRuntimeDrift(root);

      return { staleBranches, worktrees, runtimeDrift };
    } catch (e) {
      if (e instanceof WorkspaceSecurityError) {
        reply.status(e.code === 'NOT_FOUND' ? 404 : 403);
        return { error: e.message };
      }
      throw e;
    }
  });
};
