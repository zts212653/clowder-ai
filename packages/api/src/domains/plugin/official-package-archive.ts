import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packageDirectoryName } from './external-runtime/index.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';
import { OfficialPluginInstallError } from './official-package-errors.js';

const ARCHIVE_FILENAME = 'package.tgz';
export const MAX_OFFICIAL_PACKAGE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

function verifyDigest(bytes: Uint8Array, expectedDigest: string): void {
  if (!expectedDigest.startsWith('sha512-')) {
    throw new OfficialPluginInstallError('PACKAGE_DIGEST_MISMATCH', 'official package digest is not canonical');
  }
  const expected = Buffer.from(expectedDigest.slice('sha512-'.length), 'base64');
  const actual = createHash('sha512').update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new OfficialPluginInstallError(
      'PACKAGE_DIGEST_MISMATCH',
      'downloaded package bytes do not match the official catalog digest',
    );
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OFFICIAL_PACKAGE_BYTES) {
    throw new OfficialPluginInstallError('PACKAGE_TOO_LARGE', 'official package exceeds the Host size limit');
  }
  if (!response.body) {
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'official package response has no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_OFFICIAL_PACKAGE_BYTES) {
      throw new OfficialPluginInstallError('PACKAGE_TOO_LARGE', 'official package exceeds the Host size limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function downloadCatalogArchive(entry: OfficialPluginCatalogEntry): Promise<Uint8Array> {
  const url = new URL(entry.archiveUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') {
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'official package URL is outside npm registry');
  }
  try {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new OfficialPluginInstallError(
        'PACKAGE_DOWNLOAD_FAILED',
        `official package registry returned HTTP ${response.status}`,
      );
    }
    return await readBoundedBody(response);
  } catch (error) {
    if (error instanceof OfficialPluginInstallError) throw error;
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'official package download failed', {
      cause: error,
    });
  }
}

export async function publishOfficialPackageArchive(
  packagesRoot: string,
  packageDigest: string,
  bytes: Uint8Array,
): Promise<void> {
  verifyDigest(bytes, packageDigest);
  await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  const targetRoot = resolve(packagesRoot, packageDirectoryName(packageDigest));
  const targetArchive = resolve(targetRoot, ARCHIVE_FILENAME);
  try {
    verifyDigest(await readFile(targetArchive), packageDigest);
    return;
  } catch (error) {
    if (error instanceof OfficialPluginInstallError) throw error;
  }

  const stagingRoot = await mkdtemp(resolve(packagesRoot, '.install-'));
  try {
    await writeFile(resolve(stagingRoot, ARCHIVE_FILENAME), bytes, { mode: 0o600, flag: 'wx' });
    try {
      await rename(stagingRoot, targetRoot);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      verifyDigest(await readFile(targetArchive), packageDigest);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
