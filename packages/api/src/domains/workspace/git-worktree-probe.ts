import { execFile } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type GitResult = { ok: true; stdout: string } | { ok: false; err: unknown };

async function execGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
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

function gitErrorStderr(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('stderr' in err)) return '';
  return String((err as { stderr?: unknown }).stderr ?? '');
}

function isNotAGitRepositoryError(err: unknown): boolean {
  return /not a git repository/i.test(gitErrorStderr(err));
}

async function hasGitMarkerInParents(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  while (true) {
    // lstat, not stat: a dangling `.git` symlink is still a damaged checkout
    // marker and must not be classified as a plain non-Git directory.
    if (
      await lstat(join(current, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function pathKind(path: string): Promise<'file' | 'directory' | null> {
  return stat(path).then(
    (s) => (s.isFile() ? 'file' : s.isDirectory() ? 'directory' : null),
    () => null,
  );
}

async function hasBareGitRepositoryMarkers(cwd: string): Promise<boolean> {
  const root = resolve(cwd);
  const [head, config, objects, refs] = await Promise.all([
    pathKind(join(root, 'HEAD')),
    pathKind(join(root, 'config')),
    pathKind(join(root, 'objects')),
    pathKind(join(root, 'refs')),
  ]);
  if (objects !== 'directory' || refs !== 'directory') return false;
  if (head === 'file' || config === 'file') return true;
  // A bare repository whose HEAD/config were removed still has canonical
  // storage. Plain directories with empty objects/refs remain non-Git.
  const [pack, heads] = await Promise.all([
    pathKind(join(root, 'objects', 'pack')),
    pathKind(join(root, 'refs', 'heads')),
  ]);
  return pack === 'directory' || heads === 'directory';
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

export type GitWorkTreeProbe = 'git' | 'bare' | 'not-git' | 'unavailable';

/**
 * Classify the registered root as a normal worktree, a readable bare
 * repository, a confirmed non-Git directory, or an environment/probe failure.
 * Bare repositories are still Git repositories, but they have no working tree.
 */
export async function probeGitWorkTree(cwd: string): Promise<GitWorkTreeProbe> {
  const result = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (result.ok) {
    if (result.stdout.trim() === 'true') return 'git';
    const bare = await execGit(cwd, ['rev-parse', '--is-bare-repository']);
    if (bare.ok && bare.stdout.trim() === 'true') return 'bare';
    return 'not-git';
  }
  if (isGitExecutableUnavailableError(result.err)) return 'unavailable';
  if (isGitExit128(result.err)) {
    if (await hasGitMarkerInParents(cwd)) return 'unavailable';
    if (await hasBareGitRepositoryMarkers(cwd)) return 'unavailable';
    if (isNotAGitRepositoryError(result.err)) return 'not-git';
  }
  return 'unavailable';
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  const probe = await probeGitWorkTree(cwd);
  if (probe === 'unavailable') throw new Error('Git repository probe failed');
  return probe === 'git' || probe === 'bare';
}

export async function readGitWorktreeList(cwd: string): Promise<string | null> {
  if (!(await isInsideGitWorkTree(cwd)) && !(await isBareGitRepository(cwd))) return null;

  const result = await execGit(cwd, ['worktree', 'list', '--porcelain']);
  if (result.ok) return result.stdout;
  if (isGitExecutableUnavailableError(result.err)) return null;
  throw result.err;
}
