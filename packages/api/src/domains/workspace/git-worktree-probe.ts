import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
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

async function hasGitMarkerInParents(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  while (true) {
    if (
      await stat(join(current, '.git')).then(
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

async function hasBareGitRepositoryMarkers(cwd: string): Promise<boolean> {
  const root = resolve(cwd);
  const stats = await Promise.all([
    stat(join(root, 'HEAD')).then(
      (s) => s,
      () => null,
    ),
    stat(join(root, 'objects')).then(
      (s) => s,
      () => null,
    ),
    stat(join(root, 'refs')).then(
      (s) => s,
      () => null,
    ),
  ]);
  const [head, objects, refs] = stats;
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
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

export async function readGitWorktreeList(cwd: string): Promise<string | null> {
  if (!(await isInsideGitWorkTree(cwd)) && !(await isBareGitRepository(cwd))) return null;

  const result = await execGit(cwd, ['worktree', 'list', '--porcelain']);
  if (result.ok) return result.stdout;
  if (isGitExecutableUnavailableError(result.err)) return null;
  throw result.err;
}
