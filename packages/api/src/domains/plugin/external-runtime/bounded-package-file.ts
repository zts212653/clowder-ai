import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Snapshot a fixed-size regular file without following a final-component link.
 * Private package staging plus the caller's whole-tree checks fence directory races.
 */
export async function readBoundedPackageFile(root: string, entrypoint: string, budget: number): Promise<Buffer> {
  const physicalRoot = await realpath(root);
  const path = resolve(physicalRoot, entrypoint);
  const rel = relative(physicalRoot, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('package path escapes root');
  if ((await realpath(path)) !== path) throw new Error('package path contains a symlink');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > budget)
    throw new Error('package file budget or type invalid');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error('package file changed before read');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('package file shortened during read');
      offset += bytesRead;
    }
    const after = await file.stat();
    const linked = await lstat(path);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      linked.ino !== opened.ino ||
      linked.dev !== opened.dev ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error('package file changed during read');
    return bytes;
  } finally {
    await file.close();
  }
}
