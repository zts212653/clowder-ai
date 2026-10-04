import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { digestWritebackBytes, WorkspaceWritebackError, type WritebackRecord } from './journal.js';

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function identity(path: string) {
  try {
    const value = await lstat(path, { bigint: true });
    return value.isFile() ? { dev: String(value.dev), ino: String(value.ino) } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function prepareWritebackFile(record: WritebackRecord, bytes: Buffer, proofDirectory: string) {
  await mkdir(proofDirectory, { recursive: true, mode: 0o700 });
  // The hardlink keeps the inode allocated until its durable receipt exists. A stored inode number alone
  // could be recycled after another writer replaces our file. Equal bytes are never evidence of our write.
  const directory = await realpath(proofDirectory);
  const key = record.receiptRef.split(':')[1];
  const temporaryPath = join(dirname(record.targetPath), `.f309-${key}.tmp`);
  const proofPath = join(directory, `${key}.proof`);
  // Only intent can recreate preparation: rename is forbidden until prepared is durable.
  await unlink(temporaryPath).catch(missingOnly);
  await unlink(proofPath).catch(missingOnly);
  const original = await lstat(record.targetPath);
  if (!original.isFile()) throw new WorkspaceWritebackError('access_denied');
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    original.mode & 0o777,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  // EXDEV / denied evidence storage fails closed, never substitutes a copy for the hardlink.
  await link(temporaryPath, proofPath);
  await syncDirectory(directory);
  await syncDirectory(dirname(temporaryPath));
  const id = await identity(proofPath);
  if (!id) throw new WorkspaceWritebackError('proof_unavailable');
  return { path: proofPath, temporaryPath, ...id };
}

export async function inspectPreparedWriteback(
  record: WritebackRecord,
): Promise<'not_applied' | 'applied' | 'unknown'> {
  const proof = record.proof;
  if (!proof) return 'unknown';
  const matches = (id: Awaited<ReturnType<typeof identity>>) => id?.dev === proof.dev && id?.ino === proof.ino;
  if (!matches(await identity(proof.path))) return 'unknown';
  const [temporary, target] = await Promise.all([identity(proof.temporaryPath), identity(record.targetPath)]);
  if (!temporary && matches(target)) return 'applied';
  if (matches(temporary) && !matches(target)) {
    return digestWritebackBytes(await readFile(proof.temporaryPath)) === record.candidateRevision
      ? 'not_applied'
      : 'unknown';
  }
  return 'unknown';
}

export async function replacePreparedWriteback(record: WritebackRecord): Promise<void> {
  if (!record.proof) throw new WorkspaceWritebackError('proof_unavailable');
  await rename(record.proof.temporaryPath, record.targetPath);
}

export async function cleanWritebackProof(record: WritebackRecord): Promise<void> {
  if (!record.proof) return;
  await unlink(record.proof.path).catch(missingOnly);
  await unlink(record.proof.temporaryPath).catch(missingOnly);
}

function missingOnly(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
