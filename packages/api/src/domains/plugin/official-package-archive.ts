import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { packageDirectoryName } from './external-runtime/index.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';
import { OfficialPluginInstallError } from './official-package-errors.js';

const ARCHIVE_FILENAME = 'package.tgz';
export const MAX_PLUGIN_PACKAGE_BYTES = 32 * 1024 * 1024;
/** @deprecated Use MAX_PLUGIN_PACKAGE_BYTES for source-neutral admission. */
export const MAX_OFFICIAL_PACKAGE_BYTES = MAX_PLUGIN_PACKAGE_BYTES;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const log = createModuleLogger('plugin/official-package-archive');

// Transport errors may wrap an AggregateError with one cause per address.
// Keep that diagnostic chain, without copying arbitrary error fields or bodies.
function describeDownloadError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: typeof error === 'string' ? error.slice(0, 512) : typeof error };
  }
  if (depth >= 4) return { name: error.name.slice(0, 128), truncated: true };
  const diagnostic: Record<string, unknown> = {
    name: error.name.slice(0, 128),
    message: error.message.slice(0, 512),
  };
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string') diagnostic.code = code.slice(0, 128);
  if (error.cause !== undefined) diagnostic.cause = describeDownloadError(error.cause, depth + 1);
  if (error instanceof AggregateError) {
    diagnostic.errors = error.errors.slice(0, 4).map((cause) => describeDownloadError(cause, depth + 1));
    if (error.errors.length > 4) diagnostic.errorsTruncated = true;
  }
  return diagnostic;
}

export function verifyPluginPackageDigest(bytes: Uint8Array, expectedDigest: string): void {
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

async function readBoundedBody(response: Response, progress: { bytesReceived: number }): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new OfficialPluginInstallError('PACKAGE_TOO_LARGE', 'official package exceeds the Host size limit');
  }
  if (!response.body) {
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'official package response has no body');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    progress.bytesReceived = total;
    if (total > MAX_PLUGIN_PACKAGE_BYTES) {
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
  const startedAt = performance.now();
  let phase: 'fetch' | 'response' | 'body' = 'fetch';
  let response: Response | null = null;
  const progress = { bytesReceived: 0 };
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { accept: 'application/octet-stream' },
    });
    phase = 'response';
    if (!response.ok) {
      throw new OfficialPluginInstallError(
        'PACKAGE_DOWNLOAD_FAILED',
        `official package registry returned HTTP ${response.status}`,
      );
    }
    phase = 'body';
    return await readBoundedBody(response, progress);
  } catch (error) {
    log.warn(
      {
        catalogId: entry.catalogId,
        packageName: entry.packageName,
        version: entry.version,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        bytesReceived: progress.bytesReceived,
        response: response
          ? {
              url: response.url || null,
              status: response.status,
              redirected: response.redirected,
              contentLength: response.headers.get('content-length'),
            }
          : null,
        error: describeDownloadError(error),
      },
      'Official package archive download failed',
    );
    if (error instanceof OfficialPluginInstallError) throw error;
    throw new OfficialPluginInstallError('PACKAGE_DOWNLOAD_FAILED', 'official package download failed', {
      cause: error,
    });
  }
}

export async function publishPluginPackageArchive(
  packagesRoot: string,
  packageDigest: string,
  bytes: Uint8Array,
): Promise<void> {
  verifyPluginPackageDigest(bytes, packageDigest);
  await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  const targetRoot = resolve(packagesRoot, packageDirectoryName(packageDigest));
  const targetArchive = resolve(targetRoot, ARCHIVE_FILENAME);
  try {
    verifyPluginPackageDigest(await readFile(targetArchive), packageDigest);
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
      verifyPluginPackageDigest(await readFile(targetArchive), packageDigest);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

/** @deprecated Source-neutral callers should use publishPluginPackageArchive. */
export const publishOfficialPackageArchive = publishPluginPackageArchive;
