import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktopRoot = join(projectRoot, 'desktop');
const defaultSevenZip = join(desktopRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

const RELEASE = 'winCodeSign-2.6.0';
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
  const base = (env.ELECTRON_BUILDER_BINARIES_MIRROR || DEFAULT_MIRROR).replace(/\/?$/, '/');
  return `${base}${RELEASE}/${RELEASE}.7z`;
}

export function extractionArgs(archivePath, outputDir) {
  return ['x', archivePath, `-o${outputDir}`, '-x!darwin\\*', '-x!linux\\*', '-y'];
}

export function isPrewarmed(targetDir) {
  return (
    existsSync(join(targetDir, 'rcedit-x64.exe')) && existsSync(join(targetDir, 'windows-10', 'x64', 'signtool.exe'))
  );
}

function findCachedArchive(cacheRoot) {
  const dir = join(cacheRoot, 'winCodeSign');
  if (!existsSync(dir)) return null;
  try {
    const matches = readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.7z'))
      .map((name) => join(dir, name))
      .filter((file) => statSync(file).size > 5_000_000)
      .sort();
    return matches.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function download(url, output, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`winCodeSign download failed: HTTP ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 5_000_000) throw new Error(`winCodeSign archive is unexpectedly small: ${bytes.length} bytes`);
  writeFileSync(output, bytes);
}

export async function ensurePrewarmedWinCodeSign({
  cacheRoot = resolveCacheRoot(),
  sevenZipPath = defaultSevenZip,
  fetchImpl = fetch,
  log = console.log,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') {
    log('winCodeSign prewarm skipped (not Windows)');
    return { skipped: true };
  }

  const target = expectedWinCodeSignDir(cacheRoot);
  if (isPrewarmed(target)) {
    log(`winCodeSign already prewarmed: ${target}`);
    return { skipped: true, target };
  }

  if (!existsSync(sevenZipPath)) {
    throw new Error(`7za.exe not found: ${sevenZipPath}; run npm ci in desktop/ first`);
  }

  const cacheDir = join(cacheRoot, 'winCodeSign');
  mkdirSync(cacheDir, { recursive: true });
  let archivePath = findCachedArchive(cacheRoot);
  if (!archivePath) {
    archivePath = join(cacheDir, `${RELEASE}.7z`);
    const url = winCodeSignArchiveUrl();
    log(`downloading winCodeSign: ${url}`);
    await download(url, archivePath, fetchImpl);
  } else {
    log(`using cached winCodeSign archive: ${archivePath}`);
  }

  const temp = join(cacheDir, `.extract-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(temp, { recursive: true });
    execFileSync(sevenZipPath, extractionArgs(archivePath, temp), { stdio: 'inherit' });
    if (!isPrewarmed(temp)) {
      throw new Error(`winCodeSign extraction did not produce the Windows tools: ${temp}`);
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(temp, target);
    log(`winCodeSign prewarmed: ${target}`);
    return { skipped: false, target };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensurePrewarmedWinCodeSign();
}
