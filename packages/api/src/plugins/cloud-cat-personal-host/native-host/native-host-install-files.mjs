import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeAtomicFile(path, bytes, mode) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(parent, 0o700);
  const temporaryPath = resolve(parent, `.${randomUUID()}.install.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== 'win32') await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readOptionalFileSnapshot(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`installation path must be a regular file: ${path}`);
    return { bytes: await readFile(path), mode: metadata.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function restoreFileSnapshot(path, snapshot) {
  if (snapshot) {
    await writeAtomicFile(path, snapshot.bytes, snapshot.mode);
    return;
  }
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export async function readManifest(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('native host manifest must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
    throw new Error('native host manifest must have mode 0600');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}
