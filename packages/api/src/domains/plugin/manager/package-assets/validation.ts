import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PluginIconSpec } from '@cat-cafe/shared';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { VerifiedPluginPackage } from '../../external-runtime/types.js';
import type { PluginPackageRecord } from '../../host-inventory/types.js';
import { type PluginManagerPackageAsset, PluginManagerPackageAssetError } from './contract.js';

const MAX_PLUGIN_ICON_BYTES = 1024 * 1024;
const MAX_PLUGIN_README_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from('IHDR');

interface PackageIdentity {
  readonly pluginId: string;
  readonly version: string;
  readonly icon?: Exclude<PluginIconSpec, string>;
}

export function objectIcon(value: unknown): Exclude<PluginIconSpec, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { type?: unknown; src?: unknown };
  if (
    (candidate.type !== 'svg' && candidate.type !== 'png') ||
    typeof candidate.src !== 'string' ||
    candidate.src.length === 0
  ) {
    return undefined;
  }
  return { type: candidate.type, src: candidate.src };
}

function packageIdentity(manifest: unknown): PackageIdentity | undefined {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  const candidate = manifest as { pluginId?: unknown; version?: unknown; icon?: unknown };
  if (typeof candidate.pluginId !== 'string' || typeof candidate.version !== 'string') return undefined;
  const icon = objectIcon(candidate.icon);
  return {
    pluginId: candidate.pluginId,
    version: candidate.version,
    ...(icon === undefined ? {} : { icon }),
  };
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertPng(bytes: Buffer): void {
  if (
    bytes.byteLength < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    !bytes.subarray(12, 16).equals(PNG_IHDR)
  ) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared PNG icon has invalid media bytes');
  }
}

function assertSvg(bytes: Buffer): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared SVG icon is not UTF-8 XML', { cause: error });
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared SVG icon is not safe XML');
  }
  try {
    const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, removeNSPrefix: true }).parse(
      text,
    ) as Record<string, unknown>;
    if (!Object.hasOwn(parsed, 'svg')) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared SVG icon has no SVG document root');
    }
  } catch (error) {
    if (error instanceof PluginManagerPackageAssetError) throw error;
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared SVG icon could not be parsed', {
      cause: error,
    });
  }
}

export async function readVerifiedIcon(
  located: VerifiedPluginPackage,
  expected: PackageIdentity,
): Promise<PluginManagerPackageAsset> {
  const icon = verifiedPackageIcon(located.manifest, expected);
  await located.verifyIntegrity();
  const bytes = await readBoundedStableFile(
    await resolveDeclaredIconPath(located.rootDir, icon.src),
    MAX_PLUGIN_ICON_BYTES,
  );
  await located.verifyIntegrity();

  return pluginIconAsset(icon.type, bytes);
}

export function pluginIconAsset(type: 'png' | 'svg', bytes: Buffer): PluginManagerPackageAsset {
  if (bytes.length > MAX_PLUGIN_ICON_BYTES)
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin icon exceeds size limit');
  if (type === 'png') assertPng(bytes);
  else assertSvg(bytes);
  return {
    bytes,
    contentType: type === 'png' ? 'image/png' : 'image/svg+xml',
    etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
  };
}

export function verifiedPackageIcon(manifest: unknown, expected: PackageIdentity): Exclude<PluginIconSpec, string> {
  const identity = packageIdentity(manifest);
  if (!identity || identity.pluginId !== expected.pluginId || identity.version !== expected.version) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'package icon identity does not match Host truth');
  }
  if (!identity.icon) {
    throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'plugin does not declare a package icon');
  }
  if (expected.icon && JSON.stringify(identity.icon) !== JSON.stringify(expected.icon)) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'package icon declaration does not match Host truth');
  }
  return identity.icon;
}

async function resolveDeclaredIconPath(rootDir: string, source: string): Promise<string> {
  try {
    const root = await realpath(rootDir);
    const declaredPath = resolve(root, source);
    if (!pathInside(root, declaredPath)) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared plugin icon escapes the package root');
    }
    const iconPath = await realpath(declaredPath);
    if (!pathInside(root, iconPath)) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'declared plugin icon escapes the package root');
    }
    return iconPath;
  } catch (error) {
    if (error instanceof PluginManagerPackageAssetError) throw error;
    throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'declared plugin icon is unavailable', {
      cause: error,
    });
  }
}

async function readBoundedStableFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error) => {
    throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'plugin package file is unavailable', {
      cause: error,
    });
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin package file is not a bounded regular file');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin package file changed while being read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function packageIdentityMatches(manifest: unknown, expected: PackageIdentity): boolean {
  const identity = packageIdentity(manifest);
  return identity?.pluginId === expected.pluginId && identity.version === expected.version;
}

async function resolvePackageReadmePath(rootDir: string): Promise<string | undefined> {
  const root = await realpath(rootDir);
  const declaredPath = resolve(root, 'README.md');
  try {
    const readmePath = await realpath(declaredPath);
    if (!pathInside(root, readmePath)) {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin README escapes the package root');
    }
    return readmePath;
  } catch (error) {
    if (error instanceof PluginManagerPackageAssetError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin README could not be resolved', {
      cause: error,
    });
  }
}

export async function readVerifiedReadme(
  located: VerifiedPluginPackage,
  expected: PackageIdentity,
): Promise<string | undefined> {
  if (!packageIdentityMatches(located.manifest, expected)) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'package README identity does not match Host truth');
  }
  await located.verifyIntegrity();
  const readmePath = await resolvePackageReadmePath(located.rootDir);
  if (readmePath === undefined) return undefined;
  const bytes = await readBoundedStableFile(readmePath, MAX_PLUGIN_README_BYTES);
  await located.verifyIntegrity();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'plugin README is not valid UTF-8');
  }
}

export function inventoryIdentity(record: PluginPackageRecord): PackageIdentity {
  const identity = packageIdentity(record.manifest);
  if (!identity) {
    throw new PluginManagerPackageAssetError('INVALID_ASSET', 'installed package metadata is invalid');
  }
  return identity;
}
