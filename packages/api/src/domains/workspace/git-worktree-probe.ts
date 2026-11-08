import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type GitResult = { ok: true; stdout: string } | { ok: false; err: unknown };

async function execGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, ...(env ? { env } : {}) });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, err };
  }
}

function isGitExecutableUnavailableError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return code === 'ENOENT';
}

function isGitExit128(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return code === '128';
}

type MarkerMode = 'discovery' | 'strict';

function isMissingPath(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function hasGitMarkerInParents(cwd: string, mode: MarkerMode = 'discovery'): Promise<boolean> {
  const inspect = mode === 'strict' ? lstat : stat;
  let current = resolve(cwd);
  while (true) {
    if (
      await inspect(join(current, '.git')).then(
        () => true,
        (err: unknown) => mode === 'strict' && !isMissingPath(err),
      )
    )
      return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function hasBareGitRepositoryMarkers(cwd: string, mode: MarkerMode = 'discovery'): Promise<boolean> {
  const root = resolve(cwd);
  const inspect = mode === 'strict' ? lstat : stat;
  let inaccessible = false;
  const readMarker = (name: string) =>
    inspect(join(root, name)).catch((err: unknown) => {
      if (mode === 'strict' && !isMissingPath(err)) inaccessible = true;
      return null;
    });
  const stats = await Promise.all(['HEAD', 'objects', 'refs'].map(readMarker));
  if (inaccessible) return true;
  const [head, objects, refs] = stats;
  if (head?.isFile() && objects?.isDirectory() && refs?.isDirectory()) return true;
  if (mode !== 'strict' || !stats.some(Boolean)) return false;

  // Canonical storage can survive removal of both HEAD and local config.
  // Generic objects/refs directories alone are not repository evidence.
  if (objects?.isDirectory() && refs?.isDirectory()) {
    const storage = await Promise.all(['objects/info', 'objects/pack', 'refs/heads', 'refs/tags'].map(readMarker));
    if (inaccessible || storage.every((entry) => entry?.isDirectory())) return true;
  }

  // A partial bare layout is recognizable from its repository-local config.
  // Ask Git to parse it; ordinary HEAD/objects names alone prove nothing.
  const config = await execGit(root, ['config', '--file', join(root, 'config'), '--type=bool', '--get', 'core.bare'], {
    ...process.env,
    LC_ALL: 'C',
  });
  return config.ok && config.stdout.trim() === 'true';
}

async function isInsideGitWorkTree(cwd: string): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (result.ok) return result.stdout.trim() === 'true';
  if (isGitExecutableUnavailableError(result.err)) return false;
  if (isGitExit128(result.err) && !(await hasGitMarkerInParents(cwd))) return false;
  throw result.err;
}

async function isBareGitRepository(cwd: string): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--is-bare-repository']);
  if (result.ok) return result.stdout.trim() === 'true';
  const hasCheckoutMarker = await hasGitMarkerInParents(cwd);
  const hasBareMarkers = await hasBareGitRepositoryMarkers(cwd);
  if (isGitExecutableUnavailableError(result.err)) return false;
  if (isGitExit128(result.err) && !hasCheckoutMarker && !hasBareMarkers) return false;
  throw result.err;
}

export type GitRepositoryProbe = 'git' | 'not-git' | 'unavailable';

function isConfirmedNonRepositoryError(err: unknown): boolean {
  const stderr = typeof err === 'object' && err !== null && 'stderr' in err ? err.stderr : null;
  return (
    isGitExit128(err) &&
    typeof stderr === 'string' &&
    /(?:^|\n)fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^\r\n]+)\)(?:: \.git)?(?:\r?\n|$)/.test(
      stderr,
    )
  );
}

/**
 * A valid repository context includes bare repositories, whose log still works.
 * Exit 128 also covers config/permission failures. Only Git's confirmed C-locale
 * non-repository diagnostic can establish the normal empty state; filesystem
 * markers merely prevent damaged repositories from being called non-Git.
 */
export async function probeGitRepository(cwd: string): Promise<GitRepositoryProbe> {
  const result = await execGit(cwd, ['rev-parse', '--git-dir'], { ...process.env, LC_ALL: 'C' });
  if (result.ok) return result.stdout.trim() ? 'git' : 'unavailable';
  if (
    isConfirmedNonRepositoryError(result.err) &&
    !(await hasGitMarkerInParents(cwd, 'strict')) &&
    !(await hasBareGitRepositoryMarkers(cwd, 'strict'))
  )
    return 'not-git';
  return 'unavailable';
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  const probe = await probeGitRepository(cwd);
  if (probe === 'unavailable') throw new Error('Git repository probe failed');
  if (probe === 'not-git') return false;
  const inside = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) throw inside.err;
  return inside.stdout.trim() === 'true';
}

export async function readGitWorktreeList(cwd: string): Promise<string | null> {
  if (!(await isInsideGitWorkTree(cwd)) && !(await isBareGitRepository(cwd))) return null;

  const result = await execGit(cwd, ['worktree', 'list', '--porcelain']);
  if (result.ok) return result.stdout;
  if (isGitExecutableUnavailableError(result.err)) return null;
  throw result.err;
}
