import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function operationDirectory(root: string, id: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('invalid_output_identity');
  for (const path of [root, join(root, createHash('sha256').update(id).digest('hex'))]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('invalid_output_directory');
  }
  return join(root, createHash('sha256').update(id).digest('hex'));
}

/** Publish complete immutable bytes atomically; CAS never exposes a partially written JSON record. */
export async function writeOutputRecord(path: string, value: unknown): Promise<boolean> {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function readOutputRecord(path: string): Promise<unknown | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    // Atomic publication briefly has the final link plus this writer's private temporary link.
    if (
      !stat.isFile() ||
      stat.nlink < 1 ||
      stat.nlink > 2 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 128 * 1024
    )
      throw new Error('invalid_output_record');
    const bytes = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 128 * 1024) throw new Error('invalid_output_record');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await file.close();
  }
}
