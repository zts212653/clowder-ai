import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NATIVE_HOST_ARTIFACT_FILES = Object.freeze([
  'conversation-binding.mjs',
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
  if ((await digestNativeHostArtifactDirectory(artifactDirectory)) !== artifactDigest) {
    throw new Error('installed native host artifact digest mismatch');
  }
  return { artifactDigest, artifactDirectory, artifactEntrypoint: join(artifactDirectory, 'native-host-cli.mjs') };
}
