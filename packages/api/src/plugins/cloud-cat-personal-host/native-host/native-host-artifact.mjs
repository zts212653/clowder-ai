import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NATIVE_HOST_ARTIFACT_FILES = Object.freeze([
  'assistant-return-inbox.mjs',
  'conversation-binding.mjs',
  'conversation-title-exchange.mjs',
  'conversation-titles.mjs',
  'native-framing.mjs',
  'native-host-cli.mjs',
  'native-host.mjs',
  'native-ledger.mjs',
  'native-results.mjs',
  'native-socket-lease.mjs',
  'pairing-record.mjs',
]);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function digestNativeHostArtifactDirectory(directory) {
  const digest = createHash('sha512');
  for (const filename of NATIVE_HOST_ARTIFACT_FILES) {
    const bytes = await readFile(join(directory, filename));
    digest.update(filename, 'utf8');
    digest.update(Buffer.of(0));
    digest.update(bytes);
    digest.update(Buffer.of(0));
  }
  return `sha512:${digest.digest('hex')}`;
}

async function readBoundedMember(file, limit) {
  const metadata = await file.stat();
  if (!metadata.isFile() || metadata.size > limit) throw new Error('invalid artifact file');
  const buffer = Buffer.alloc(limit + 1);
  let totalRead = 0;
  while (totalRead < buffer.length) {
    const { bytesRead } = await file.read(buffer, totalRead, buffer.length - totalRead, totalRead);
    if (bytesRead === 0) break;
    totalRead += bytesRead;
  }
  if (totalRead > limit) throw new Error('artifact exceeds size limit');
  return buffer.subarray(0, totalRead);
}

/** The installed generation owns its member set; its pinned digest covers every member. */
export async function digestInstalledNativeHostArtifactDirectory(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('artifact must be a directory');
    const files = (await readdir(directory)).sort();
    if (files.length > 64 || !files.includes('native-host-cli.mjs')) throw new Error('invalid artifact members');
    const digest = createHash('sha512');
    let remainingBytes = 2 * 1024 * 1024;
    for (const filename of files) {
      if (!/^[a-z0-9-]+\.mjs$/.test(filename)) throw new Error('invalid artifact member');
      // Nonblocking open prevents a swapped FIFO from stalling before fstat can reject it.
      const file = await open(
        join(directory, filename),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const bytes = await readBoundedMember(file, remainingBytes);
        remainingBytes -= bytes.length;
        digest.update(filename, 'utf8').update(Buffer.of(0)).update(bytes).update(Buffer.of(0));
      } finally {
        await file.close();
      }
    }
    return `sha512:${digest.digest('hex')}`;
  } catch (cause) {
    // A missing member in a recorded generation is corruption, not an absent install.
    throw new Error('installed native host artifact is unreadable or invalid', { cause });
  }
}

async function stageArtifact(sourceDirectory, stagingDirectory, expectedDigest) {
  if (process.platform !== 'win32') await chmod(stagingDirectory, 0o700);
  for (const filename of NATIVE_HOST_ARTIFACT_FILES) {
    await writeFile(join(stagingDirectory, filename), await readFile(join(sourceDirectory, filename)), {
      mode: 0o600,
    });
  }
  if ((await digestNativeHostArtifactDirectory(stagingDirectory)) !== expectedDigest) {
    throw new Error('staged native host artifact digest mismatch');
  }
}

async function publishStagedArtifact(stagingDirectory, artifactDirectory) {
  try {
    await rename(stagingDirectory, artifactDirectory);
  } catch (error) {
    if (!(error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY')) throw error;
  }
}

async function ensureArtifactPublished(sourceDirectory, artifactsDirectory, artifactDirectory, artifactDigest) {
  if (await pathExists(artifactDirectory)) return;
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(artifactsDirectory, 0o700);
  const stagingDirectory = await mkdtemp(join(artifactsDirectory, '.install-'));
  try {
    await stageArtifact(sourceDirectory, stagingDirectory, artifactDigest);
    await publishStagedArtifact(stagingDirectory, artifactDirectory);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function publishNativeHostArtifact(sourceDirectory, artifactsDirectory) {
  const artifactDigest = await digestNativeHostArtifactDirectory(sourceDirectory);
  const artifactDirectory = join(artifactsDirectory, artifactDigest.slice('sha512:'.length));
  await ensureArtifactPublished(sourceDirectory, artifactsDirectory, artifactDirectory, artifactDigest);
  if ((await digestInstalledNativeHostArtifactDirectory(artifactDirectory)) !== artifactDigest) {
    throw new Error('installed native host artifact digest mismatch');
  }
  return { artifactDigest, artifactDirectory, artifactEntrypoint: join(artifactDirectory, 'native-host-cli.mjs') };
}
