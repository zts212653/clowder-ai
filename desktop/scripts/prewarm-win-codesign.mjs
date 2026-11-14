import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = join(projectRoot, 'desktop');
const defaultSevenZip = join(desktopRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

export const RELEASE = 'winCodeSign-2.6.0';

// SHA-512 of winCodeSign-2.6.0.7z as published in the release notes of
// https://github.com/electron-userland/electron-builder-binaries/releases/tag/winCodeSign-2.6.0
// ("Sha512: 6LQI..."). The same digest was reproduced from the GitHub release
// asset and the npmmirror binary mirror on 2026-11-05 (5,635,384 bytes), so the
// cache is keyed by content, not by file name, extension or size.
export const WIN_CODE_SIGN_SHA512 =
  '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==';

export const PREWARM_MARKER = '.clowder-prewarm.json';

const DEFAULT_MIRROR = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/';

export function resolveCacheRoot(env = process.env, platform = process.platform) {
  const configured = env.ELECTRON_BUILDER_CACHE?.trim();
  if (configured) return resolve(configured);
  if (platform !== 'win32') return resolve(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'electron-builder');
  const localAppData = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'electron-builder', 'Cache');
}

export function expectedWinCodeSignDir(cacheRoot) {
  return join(cacheRoot, 'winCodeSign', RELEASE);
}

export function winCodeSignArchiveUrl(env = process.env) {
  const override = env.ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL?.trim();
  if (override) return `${override.replace(/\/+$/, '')}/${RELEASE}.7z`;

  const base = (
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    DEFAULT_MIRROR
  ).replace(/\/+$/, '');
  const customDir =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR ||
    env.npm_config_electron_builder_binaries_custom_dir ||
    env.npm_package_config_electron_builder_binaries_custom_dir ||
    env.ELECTRON_BUILDER_BINARIES_CUSTOM_DIR ||
    RELEASE;
  return `${base}/${customDir.replace(/^\/+|\/+$/g, '')}/${RELEASE}.7z`;
}

export function extractionArgs(archivePath, outputDir) {
  return ['x', archivePath, `-o${outputDir}`, '-x!darwin\\*', '-x!linux\\*', '-y'];
}

function hasWindowsTools(dir) {
  try {
    return (
      statSync(join(dir, 'rcedit-x64.exe')).size > 0 &&
      statSync(join(dir, 'windows-10', 'x64', 'signtool.exe')).size > 0
    );
  } catch {
    return false;
  }
}

function markerMatches(targetDir, expectedSha512) {
  try {
    const marker = JSON.parse(readFileSync(join(targetDir, PREWARM_MARKER), 'utf8'));
    return marker.release === RELEASE && marker.sha512 === expectedSha512;
  } catch {
    return false;
  }
}

export function isPrewarmed(targetDir, expectedSha512 = WIN_CODE_SIGN_SHA512) {
  return hasWindowsTools(targetDir) && markerMatches(targetDir, expectedSha512);
}

function sha512OfFile(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64');
}

const PUBLISH_LOCK = '.prewarm-publish.lock';

async function acquirePublishLock(cacheDir, { timeoutMs = 30_000, staleMs = 120_000 } = {}) {
  const lockDir = join(cacheDir, PUBLISH_LOCK);
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock disappeared between EEXIST and stat; retry immediately.
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`timed out waiting for winCodeSign publish lock: ${lockDir}`);
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    }
  }
}

// Cache entries are only trusted when their bytes match the pinned release
// digest. Builder temp names are fine, a differently named archive with the
// right bytes is fine, and a same-named archive with wrong bytes is not.
export function selectTrustedArchive(cacheRoot, expectedSha512 = WIN_CODE_SIGN_SHA512) {
  const dir = join(cacheRoot, 'winCodeSign');
  if (!existsSync(dir)) return null;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.7z')) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile() && sha512OfFile(file) === expectedSha512) return file;
    } catch {
      // An unreadable or partially written entry is simply not trusted.
    }
  }
  return null;
}

export async function downloadVerified(url, output, { fetchImpl = fetch, expectedSha512 = WIN_CODE_SIGN_SHA512 } = {}) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`winCodeSign download failed: HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha512').update(bytes).digest('base64');
  if (actual !== expectedSha512) {
    throw new Error(`winCodeSign archive digest mismatch: expected ${expectedSha512}, got ${actual}`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const partial = `${output}.part-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(partial, bytes);
    rmSync(output, { force: true });
    renameSync(partial, output);
  } finally {
    rmSync(partial, { force: true });
  }
  return { bytes: bytes.length };
}

function extractWith7za({ sevenZipPath, archivePath, outputDir }) {
  execFileSync(sevenZipPath, extractionArgs(archivePath, outputDir), { stdio: 'inherit' });
}

export async function ensurePrewarmedWinCodeSign({
  cacheRoot = resolveCacheRoot(),
  sevenZipPath = defaultSevenZip,
  fetchImpl = fetch,
  log = console.log,
  platform = process.platform,
  expectedSha512 = WIN_CODE_SIGN_SHA512,
  extract = extractWith7za,
} = {}) {
  if (platform !== 'win32') {
    log('winCodeSign prewarm skipped (not Windows)');
    return { skipped: true };
  }

  const target = expectedWinCodeSignDir(cacheRoot);
  if (isPrewarmed(target, expectedSha512)) {
    log(`winCodeSign already prewarmed: ${target}`);
    return { skipped: true, target };
  }
  // app-builder may have published a valid toolset without our prewarm marker.
  // Treat it as builder-owned: never delete or replace it just to add a marker.
  if (hasWindowsTools(target)) {
    log(`winCodeSign already published by builder: ${target}`);
    return { skipped: true, target };
  }

  if (!existsSync(sevenZipPath)) {
    throw new Error(`7za.exe not found: ${sevenZipPath}; run npm ci in desktop/ first`);
  }

  const cacheDir = join(cacheRoot, 'winCodeSign');
  mkdirSync(cacheDir, { recursive: true });
  let archivePath = selectTrustedArchive(cacheRoot, expectedSha512);
  if (archivePath) {
    log(`using verified winCodeSign archive: ${archivePath}`);
  } else {
    archivePath = join(cacheDir, `${RELEASE}.7z`);
    const url = winCodeSignArchiveUrl();
    log(`downloading winCodeSign: ${url}`);
    await downloadVerified(url, archivePath, { fetchImpl, expectedSha512 });
  }

  const temp = join(cacheDir, `.extract-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(temp, { recursive: true });
    await extract({ sevenZipPath, archivePath, outputDir: temp });
    if (!hasWindowsTools(temp)) {
      throw new Error(`winCodeSign extraction did not produce the Windows tools: ${temp}`);
    }
    writeFileSync(
      join(temp, PREWARM_MARKER),
      `${JSON.stringify({ release: RELEASE, sha512: expectedSha512 }, null, 2)}\n`,
    );
    const releaseLock = await acquirePublishLock(cacheDir);
    try {
      if (isPrewarmed(target, expectedSha512) || hasWindowsTools(target)) {
        log(`winCodeSign already published by another process: ${target}`);
        return { skipped: true, target };
      }
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(temp, target);
    } finally {
      releaseLock();
    }
    log(`winCodeSign prewarmed: ${target}`);
    return { skipped: false, target };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await ensurePrewarmedWinCodeSign();
}
