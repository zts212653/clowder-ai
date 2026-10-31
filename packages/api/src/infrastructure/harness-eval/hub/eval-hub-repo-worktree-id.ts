import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

interface WorktreeEntry {
  id: string;
  root: string;
  head: string;
}

function sanitizeWorktreeId(root: string): string {
  return basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.root) entries.push(current as WorktreeEntry);
      const root = line.slice('worktree '.length);
      current = {
        root,
        id: sanitizeWorktreeId(root),
        head: '',
      };
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length, 'HEAD '.length + 8);
    }
  }
  if (current.root) entries.push(current as WorktreeEntry);

  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) entry.id = `${entry.id}_${entry.head}`;
    seen.add(entry.id);
  }

  return entries;
}

function loadWorktreeEntries(repoRoot: string): WorktreeEntry[] | null {
  try {
    const stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseWorktreeList(stdout);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? String((error as { status?: unknown }).status)
        : '';
    if (code === 'ENOENT' || code === '128' || status === '128') return null;
    throw error;
  }
}

// Mirrors workspace-security's duplicate-basename worktree id contract, but
// stays sync so the eval-hub read model can keep its synchronous API.
export function resolveEvalHubRepoWorktreeId(repoRoot: string): string {
  const resolvedRoot = resolve(repoRoot);
  const fallbackId = sanitizeWorktreeId(resolvedRoot);
  const entries = loadWorktreeEntries(resolvedRoot);
  if (!entries) return fallbackId;

  const canonicalRoot = canonicalizePath(resolvedRoot);
  const matched = entries.find((entry) => {
    return entry.root === resolvedRoot || canonicalizePath(entry.root) === canonicalRoot;
  });
  return matched?.id ?? fallbackId;
}
