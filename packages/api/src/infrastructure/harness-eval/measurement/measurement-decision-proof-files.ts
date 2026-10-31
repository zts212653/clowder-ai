import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

/**
 * Contained reads for F267 owner artifacts.
 *
 * A decision proof names its artifacts by repository path, and those paths come out of a record that
 * a consumer influences. So every read here is fenced twice — lexically inside the required root, and
 * again on the physical path after symlink resolution, with `O_NOFOLLOW` on the final open. A path
 * that escapes is `invalid`, never a silent read of whatever it pointed at.
 */

export type ContainedRead = { status: 'ok'; bytes: Buffer } | { status: 'missing' } | { status: 'invalid' };

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return Boolean(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function containsSymlink(repoRoot: string, target: string): Promise<boolean> {
  if ((await lstat(repoRoot)).isSymbolicLink()) return true;
  let cursor = repoRoot;
  for (const segment of relative(repoRoot, target).split(sep)) {
    cursor = resolve(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) return true;
  }
  return false;
}

export async function readContainedFile(repoRoot: string, ref: string, requiredRoot: string): Promise<ContainedRead> {
  const lexicalRoot = resolve(repoRoot, requiredRoot);
  const lexicalTarget = resolve(repoRoot, ref);
  if (!isContained(repoRoot, lexicalRoot) || !isContained(lexicalRoot, lexicalTarget)) {
    return { status: 'invalid' };
  }

  try {
    if (await containsSymlink(repoRoot, lexicalTarget)) return { status: 'invalid' };
    const [physicalRoot, physicalTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
    if (!isContained(physicalRoot, physicalTarget)) return { status: 'invalid' };

    const handle = await open(physicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return { status: 'invalid' };
      return { status: 'ok', bytes: await handle.readFile() };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { status: isMissingFile(error) ? 'missing' : 'invalid' };
  }
}

export function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
