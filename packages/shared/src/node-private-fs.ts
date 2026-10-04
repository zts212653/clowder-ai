import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertWindowsPrivatePath } from './windows-private-path.js';

export { assertWindowsPrivatePath } from './windows-private-path.js';

export async function ensurePrivateDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') {
    await assertWindowsPrivatePath(path, 'directory', true);
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`Collective directory must be private: ${path}`);
  }
}

export async function readPrivateFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`Collective state must be a private regular file: ${path}`);
  if (process.platform === 'win32') await assertWindowsPrivatePath(path, 'file');
  else if ((metadata.mode & 0o077) !== 0) throw new Error(`Collective file permissions must be private: ${path}`);
  const flags = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeAtomicPrivate(path: string, contents: string): Promise<void> {
  await writePrivate(path, contents, false);
}

/** Publish a flushed, complete file once. Existing destinations are never replaced. */
export async function writeExclusivePrivate(path: string, contents: string): Promise<boolean> {
  return writePrivate(path, contents, true);
}

async function writePrivate(path: string, contents: string, exclusive: boolean): Promise<boolean> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
        // Unsupported hard links and arbitrary IO errors must never fall back
        // to replacement: that would transfer ownership to a losing writer.
        throw error;
      }
    } else {
      await rename(temporaryPath, path);
    }
    // Windows cannot fsync directory handles. Keep file fsync and same-directory
    // rename there; Unix still flushes the rename to stable storage.
    if (process.platform === 'win32') return true;
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return true;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
}
