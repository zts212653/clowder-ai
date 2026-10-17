import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BrowserServiceTransportError } from './transport-policy.js';

interface AssetEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}
export interface RetainedBrowserAssets {
  readonly clientBuildId: string;
  readonly assetDigest: string;
  /** Returns a copy: package/request consumers cannot mutate retained bytes. */
  read(pathname: string): { readonly bytes: Buffer; readonly contentType: string } | undefined;
}
const contentTypes = new Set([
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
  'text/css; charset=utf-8',
  'image/png',
]);
function unavailable(): never {
  throw new BrowserServiceTransportError('BROWSER_SERVICE_UNAVAILABLE');
}
function entries(value: unknown): AssetEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) unavailable();
  const seen = new Set<string>();
  let total = 0;
  return value
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Object.keys(entry).sort().join(',') !== 'contentType,path,sha256,size' ||
        typeof entry.path !== 'string' ||
        !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(entry.path) ||
        entry.path.split('/').some((part: string) => part === '.' || part === '..') ||
        seen.has(entry.path) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > 32 * 1024 * 1024 ||
        typeof entry.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !contentTypes.has(entry.contentType)
      )
        unavailable();
      total += entry.size;
      if (total > 64 * 1024 * 1024) unavailable();
      seen.add(entry.path);
      return Object.freeze({ ...entry });
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

/** Only a Host-owned catalog supplies this directory/digest, never plugin manifest paths. */
export async function loadRetainedBrowserAssets(
  directory: string,
  expected: { readonly clientBuildId: string; readonly assetDigest: string },
): Promise<RetainedBrowserAssets> {
  const root = await realpath(directory);
  const manifestPath = path.join(root, 'manifest.json');
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.size > 64 * 1024) unavailable();
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    !manifest ||
    Object.keys(manifest).sort().join(',') !== 'clientBuildId,files,version' ||
    manifest.version !== 1 ||
    manifest.clientBuildId !== expected.clientBuildId
  )
    unavailable();
  const files = entries(manifest.files);
  const digest = createHash('sha256')
    .update(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))))
    .digest('hex');
  if (digest !== expected.assetDigest) unavailable();
  const retained = new Map<string, { bytes: Buffer; contentType: string }>();
  for (const entry of files) {
    const file = path.join(root, entry.path.slice(1));
    if ((await realpath(file)) !== file) unavailable();
    const info = await lstat(file);
    if (!info.isFile() || info.size !== entry.size) unavailable();
    const bytes = await readFile(file);
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) unavailable();
    retained.set(entry.path, { bytes, contentType: entry.contentType });
  }
  if (!retained.has('/index.html')) unavailable();
  return Object.freeze({
    ...expected,
    read(pathname: string) {
      const item = retained.get(pathname === '/' ? '/index.html' : pathname);
      return item ? { bytes: Buffer.from(item.bytes), contentType: item.contentType } : undefined;
    },
  });
}
