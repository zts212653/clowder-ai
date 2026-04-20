/**
 * Git-based document reader for Mission Hub import sync.
 *
 * Primary source: `origin/main` (via `git fetch` + `git show`)
 * Fallback: local filesystem (for offline / non-git environments)
 *
 * This ensures Mission Hub always reflects the latest merged state,
 * regardless of whether `cat-cafe-runtime` has been pulled.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function findMonorepoRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

const GIT_FETCH_INTERVAL_MS = 60_000;
let lastFetchAttemptTime = 0;
let lastFetchSucceeded = false;

async function hasOriginMainRef(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'origin/main^{commit}'], {
      cwd,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Run `git fetch origin main` at most once per minute (throttles both success and failure). */
async function ensureFetched(cwd: string): Promise<boolean> {
  const now = Date.now();
  if (now - lastFetchAttemptTime < GIT_FETCH_INTERVAL_MS) return lastFetchSucceeded;
  lastFetchAttemptTime = now;
  try {
    await execFileAsync('git', ['fetch', 'origin', 'main', '--quiet'], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 10_000,
    });
    lastFetchSucceeded = true;
    return true;
  } catch {
    // If fetch flakes but we already have a local origin/main ref, keep using it.
    const hasLocalOriginMain = await hasOriginMainRef(cwd);
    lastFetchSucceeded = hasLocalOriginMain;
    return hasLocalOriginMain;
  }
}

/**
 * Read a single file from `origin/main`.
 * Returns file content as string, or null if the file doesn't exist or git fails.
 */
export async function gitShowFile(relativePath: string, cwd?: string): Promise<string | null> {
  const root = cwd ?? findMonorepoRoot();
  const fetched = await ensureFetched(root);
  if (!fetched) return null;
  try {
    const { stdout } = await execFileAsync('git', ['show', `origin/main:${relativePath}`], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * List feature doc filenames (F*.md) from `origin/main:docs/features/`.
 * Falls back to local readdir on git failure.
 */
export async function gitListFeatureDocs(featuresRelPath = 'docs/features', cwd?: string): Promise<string[]> {
  const root = cwd ?? findMonorepoRoot();
  const fetched = await ensureFetched(root);
  if (fetched) {
    try {
      const { stdout } = await execFileAsync('git', ['ls-tree', '--name-only', `origin/main:${featuresRelPath}`], {
        cwd: root,
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      });
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^F\d{3}/i.test(l) && l.endsWith('.md'));
    } catch {
      // fall through to local
    }
  }
  // Fallback: local filesystem
  try {
    const dir = join(root, featuresRelPath);
    const all = await readdir(dir);
    return all.filter((f) => /^F\d{3}/i.test(f) && f.endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * Read a feature doc file from origin/main, with local fallback.
 */
export async function readFeatureDocContent(
  filename: string,
  featuresRelPath = 'docs/features',
  cwd?: string,
): Promise<string | null> {
  const content = await gitShowFile(`${featuresRelPath}/${filename}`, cwd);
  if (content !== null) return content;
  // Fallback: local
  const root = cwd ?? findMonorepoRoot();
  try {
    return await readFile(join(root, featuresRelPath, filename), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Read BACKLOG.md from origin/main, with local fallback.
 */
export async function readBacklogContent(backlogRelPath = 'docs/ROADMAP.md', cwd?: string): Promise<string> {
  const content = await gitShowFile(backlogRelPath, cwd);
  if (content !== null) return content;
  // Fallback: local
  const root = cwd ?? findMonorepoRoot();
  return readFile(join(root, backlogRelPath), 'utf-8');
}

/** Reset fetch throttle (for testing). */
export function _resetFetchTimer(): void {
  lastFetchAttemptTime = 0;
  lastFetchSucceeded = false;
}
