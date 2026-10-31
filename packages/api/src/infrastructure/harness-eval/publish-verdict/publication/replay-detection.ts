/** Fresh, immutable main snapshot for replay checks. Git never runs on the API thread. */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FreshMainReader } from '../types.js';

const execFileAsync = promisify(execFile);
interface GitReadOptions {
  signal?: AbortSignal;
}

async function git(repoRoot: string, args: string[], timeout: number, options: GitReadOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return stdout;
}

export async function resolveRepoRoot(
  harnessFeedbackRoot: string,
  options: GitReadOptions = {},
): Promise<string | null> {
  const candidate = resolve(harnessFeedbackRoot, '..', '..');
  try {
    await git(candidate, ['rev-parse', '--git-dir'], 5000, options);
    return candidate;
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
}

/** Fetch again on collision; never replace failed fresh truth with a cached reader. */
export async function fetchAndCreateMainReader(
  repoRoot: string,
  options: GitReadOptions = {},
): Promise<FreshMainReader | null> {
  let revision: string;
  try {
    await git(repoRoot, ['fetch', 'origin', 'main', '--quiet'], 30_000, options);
    revision = (await git(repoRoot, ['rev-parse', 'origin/main'], 5000, options)).trim();
    if (!/^[0-9a-f]{40,64}$/.test(revision)) return null;
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
  const prefix = `${revision}:docs/harness-feedback`;
  return {
    async listBundleEntries() {
      try {
        return (await git(repoRoot, ['ls-tree', '--name-only', `${prefix}/bundles/`], 5000, options))
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch {
        options.signal?.throwIfAborted();
        return [];
      }
    },
    async readFile(relativePath: string) {
      try {
        return await git(repoRoot, ['show', `${prefix}/${relativePath}`], 5000, options);
      } catch {
        options.signal?.throwIfAborted();
        return null;
      }
    },
  };
}
