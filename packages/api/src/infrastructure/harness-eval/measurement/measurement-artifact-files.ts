import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { stringify } from 'yaml';

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return Boolean(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`artifact parent is a symlink: ${path}`);
    return;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
  }
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`artifact parent is a symlink: ${path}`);
}

async function prepareContainedArtifactParent(root: string, path: string): Promise<void> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('artifact worktree root must not be a symlink');
  const lexicalRoot = resolve(root);
  const physicalRoot = await realpath(root);
  const parent = resolve(physicalRoot, relative(lexicalRoot, dirname(path)));
  if (!isContained(physicalRoot, parent)) throw new Error('artifact path escapes isolated worktree');

  let cursor = physicalRoot;
  for (const segment of relative(physicalRoot, parent).split(sep)) {
    cursor = join(cursor, segment);
    await ensurePhysicalDirectory(cursor);
  }
  if (!isContained(physicalRoot, await realpath(parent))) throw new Error('artifact parent escapes isolated worktree');
}

/** Write one immutable YAML artifact without following repository-controlled symlinks. */
export async function persistImmutableMeasurementArtifact(root: string, ref: string, value: unknown): Promise<string> {
  const path = resolve(root, ref);
  if (!isContained(resolve(root), path)) throw new Error(`artifact path escapes isolated worktree: ${ref}`);
  await prepareContainedArtifactParent(root, path);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(stringify(value), 'utf8');
  } finally {
    await handle.close();
  }
  return path;
}
