import { createHash } from 'node:crypto';
import { mkdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serializeWorkspaceMutation } from './workspace-mutation-lock.js';

export class WorkspaceMutationError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

async function existing(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Caller resolves and authorizes paths; all supported F063 writers share this same process boundary. */
export function createWorkspaceFile(path: string, content: string) {
  return serializeWorkspaceMutation(async () => {
    if (await existing(path)) throw new WorkspaceMutationError(409, 'File already exists');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    return { sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) };
  });
}

export function createWorkspaceDirectory(path: string) {
  return serializeWorkspaceMutation(() => mkdir(path, { recursive: true }));
}

export function removeWorkspaceFile(path: string) {
  return serializeWorkspaceMutation(async () => {
    const current = await existing(path);
    if (!current) throw new WorkspaceMutationError(404, 'File not found');
    if (current.isDirectory()) await rmdir(path);
    else await rm(path);
  });
}

export function moveWorkspaceFile(from: string, to: string) {
  return serializeWorkspaceMutation(async () => {
    if (!(await existing(from))) throw new WorkspaceMutationError(404, 'Source not found');
    if (await existing(to)) throw new WorkspaceMutationError(409, 'Target already exists');
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  });
}

export function uploadWorkspaceFile(path: string, bytes: Buffer, overwrite: boolean) {
  return serializeWorkspaceMutation(async () => {
    if (!overwrite && (await existing(path)))
      throw new WorkspaceMutationError(409, 'File already exists. Use ?overwrite=true to replace.');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: overwrite ? 'w' : 'wx' });
  });
}
