import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';
import { resolvePersistentProjectPathDetailed } from '../../utils/persistent-project-path.js';
import { isPathUnderRoots } from '../../utils/project-path.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import { resolveWorkspaceFilesystemPath } from './workspace-security.js';

const run = promisify(execFile);
export async function roadmapGit(root: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await run(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args],
    {
      timeout: 750,
      maxBuffer: 64_000,
      signal,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_LITERAL_PATHSPECS: '1',
      },
    },
  );
  return stdout.trim();
}

/** Same repository, persistent primary checkout. Never retain a disposable linked worktree coordinate. */
export async function persistentRoadmapProject(raw: string): Promise<string> {
  if (!isAbsolute(raw) || raw.includes('\0')) throw new Error('Project root must be absolute');
  const checked = await resolvePersistentProjectPathDetailed(raw);
  if (!checked.ok) throw new Error(`Project root unavailable: ${checked.reason}`);
  const root = checked.path;
  let top: string;
  try {
    top = await roadmapGit(root, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('not a git repository'))
      return root;
    throw error;
  }
  const common = await realpath(await roadmapGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (basename(common) !== '.git') throw new Error('Cannot map project to a persistent checkout');
  const primary = await realpath(dirname(common));
  if ((await realpath(await roadmapGit(primary, ['rev-parse', '--show-toplevel']))) !== primary)
    throw new Error('Persistent checkout identity unavailable');
  const mapped = resolve(primary, relative(top, root));
  if (!isPathUnderRoots(mapped, [primary])) throw new Error('Mapped project escapes persistent checkout');
  const canonical = await resolvePersistentProjectPathDetailed(mapped);
  if (!canonical.ok) throw new Error('Persistent project unavailable');
  return canonical.path;
}

export async function recognizesRoadmapProject(
  store: IThreadStore,
  userId: string,
  root: string,
  thread: Thread,
  rawRoot?: string,
): Promise<boolean> {
  for (const candidate of new Set([root, ...(rawRoot ? [rawRoot] : [])])) {
    const found = store.hasByProject
      ? await store.hasByProject(userId, candidate)
      : (await store.listByProject(userId, candidate)).some((t) => !t.deletedAt);
    if (found) return true;
  }
  // Legacy project records can retain a symlink spelling, such as /var vs /private/var.
  const projects = new Set((await store.list(userId)).filter((t) => !t.deletedAt).map((t) => t.projectPath));
  for (const project of projects) {
    if (!isAbsolute(project)) continue;
    try {
      if ((await realpath(project)) === root) return true;
    } catch {
      /* No reachable identity proof. */
    }
  }
  // A current visible thread may still name the linked checkout that normalized to this persistent root.
  if (thread.projectPath !== 'default') {
    const known = store.hasByProject
      ? await store.hasByProject(userId, thread.projectPath)
      : (await store.listByProject(userId, thread.projectPath)).some((t) => !t.deletedAt);
    if (!known) return false;
    try {
      return (await persistentRoadmapProject(thread.projectPath)) === root;
    } catch {
      return false;
    }
  }
  return false;
}

export async function roadmapFilePath(root: string, path: string): Promise<string> {
  if (
    !path ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.split('/').some((s) => s === '..' || s === '.' || s === '') ||
    !/\.md$/i.test(path)
  )
    throw new Error('Roadmap path must be a repository-relative Markdown file without traversal');
  return resolveWorkspaceFilesystemPath(root, path);
}
