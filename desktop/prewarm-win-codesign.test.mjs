import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ensurePrewarmedWinCodeSign,
  expectedWinCodeSignDir,
  extractionArgs,
  isPrewarmed,
  PREWARM_MARKER,
  RELEASE,
  resolveCacheRoot,
  selectTrustedArchive,
  WIN_CODE_SIGN_SHA512,
  winCodeSignArchiveUrl,
} from './scripts/prewarm-win-codesign.mjs';

const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-prewarm-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedArchive(root, name, bytes) {
  const dir = join(root, 'winCodeSign');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

function stubSevenZip(root) {
  const file = join(root, '7za.exe');
  writeFileSync(file, 'stub');
  return file;
}

function fakeExtract() {
  return ({ outputDir }) => {
    mkdirSync(join(outputDir, 'windows-10', 'x64'), { recursive: true });
    writeFileSync(join(outputDir, 'rcedit-x64.exe'), 'rcedit');
    writeFileSync(join(outputDir, 'windows-10', 'x64', 'signtool.exe'), 'signtool');
  };
}

function fetchReturning(bytes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} skips before touching cache, downloading or extracting Windows tools`, async (t) => {
    const root = tempRoot(t);
    const result = await ensurePrewarmedWinCodeSign({
      platform,
      cacheRoot: join(root, 'cache'),
      sevenZipPath: join(root, 'missing-7za.exe'),
      fetchImpl: async () => assert.fail('non-Windows must not download'),
      extract: async () => assert.fail('non-Windows must not extract'),
      log: () => {},
    });
    assert.deepEqual(result, { skipped: true });
    assert.deepEqual(readdirSync(root), [], 'non-Windows must leave the cache untouched');
  });
}

test('native non-Windows CLI skips successfully with an empty cache', { skip: process.platform === 'win32' }, (t) => {
  const root = tempRoot(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./scripts/prewarm-win-codesign.mjs', import.meta.url))],
    {
      env: { ELECTRON_BUILDER_CACHE: join(root, 'cache') },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped \(not Windows\)/);
  assert.deepEqual(readdirSync(root), []);
});

test('resolveCacheRoot honours ELECTRON_BUILDER_CACHE', () => {
  assert.equal(
    resolveCacheRoot({ ELECTRON_BUILDER_CACHE: 'cache', LOCALAPPDATA: 'ignored' }, 'win32'),
    resolve('cache'),
  );
});

test('resolveCacheRoot uses LOCALAPPDATA on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(
    resolveCacheRoot({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32'),
    'C:\\Users\\x\\AppData\\Local\\electron-builder\\Cache',
  );
});

test('expected winCodeSign cache directory is stable', () => {
  const root = join(tmpdir(), 'cat-cafe-cache');
  assert.equal(expectedWinCodeSignDir(root), join(root, 'winCodeSign', RELEASE));
});

test('winCodeSign mirror URL keeps a trailing slash', () => {
  assert.equal(
    winCodeSignArchiveUrl({ ELECTRON_BUILDER_BINARIES_MIRROR: 'https://mirror.example/binaries' }),
    `https://mirror.example/binaries/${RELEASE}/${RELEASE}.7z`,
  );
});

test('winCodeSign URL follows npm mirror, custom-dir and override precedence', () => {
  assert.equal(
    winCodeSignArchiveUrl({
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://ignored.example/',
      NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npm.example/binaries/',
      NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR: '/tools/',
    }),
    `https://npm.example/binaries/tools/${RELEASE}.7z`,
  );
  assert.equal(
    winCodeSignArchiveUrl({ ELECTRON_BUILDER_BINARIES_CUSTOM_DIR: 'win-tools' }),
    `${'https://github.com/electron-userland/electron-builder-binaries/releases/download'}/win-tools/${RELEASE}.7z`,
  );
  assert.equal(
    winCodeSignArchiveUrl({ ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: 'https://override.example/assets/' }),
    `https://override.example/assets/${RELEASE}.7z`,
  );
});

test('extraction excludes darwin and linux symlink payloads', () => {
  const args = extractionArgs('C:\\cache\\winCodeSign.7z', 'C:\\cache\\out');
  assert.deepEqual(args, ['x', 'C:\\cache\\winCodeSign.7z', '-oC:\\cache\\out', '-x!darwin\\*', '-x!linux\\*', '-y']);
});

test('a cached archive is trusted by digest, not by name or size order', (t) => {
  const root = tempRoot(t);
  const good = Buffer.from('verified archive bytes');
  seedArchive(root, 'winCodeSign-2.6.0.7z', 'wrong bytes');
  seedArchive(root, 'winCodeSign-9.9.9.7z', Buffer.alloc(5 * 1024 * 1024, 1));
  writeFileSync(join(root, 'winCodeSign', 'builder-download.tmp.7z'), good);

  assert.equal(selectTrustedArchive(root, sha512(good)), join(root, 'winCodeSign', 'builder-download.tmp.7z'));
  assert.equal(selectTrustedArchive(root, sha512(Buffer.from('absent bytes'))), null);
});

test('isPrewarmed requires non-empty tools and a digest marker', (t) => {
  const root = tempRoot(t);
  const target = expectedWinCodeSignDir(root);
  mkdirSync(join(target, 'windows-10', 'x64'), { recursive: true });
  writeFileSync(join(target, 'rcedit-x64.exe'), '');
  writeFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), '');
  assert.equal(isPrewarmed(target), false, 'empty placeholder files are not a prewarmed toolset');

  writeFileSync(join(target, 'rcedit-x64.exe'), 'rcedit');
  writeFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), 'signtool');
  assert.equal(isPrewarmed(target), false, 'a toolset without a marker is not trusted');

  writeFileSync(
    join(target, PREWARM_MARKER),
    `${JSON.stringify({ release: RELEASE, sha512: WIN_CODE_SIGN_SHA512 })}\n`,
  );
  assert.equal(isPrewarmed(target), true);
});

test('ensurePrewarmedWinCodeSign reuses a verified cached archive', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('verified archive bytes');
  seedArchive(root, `${RELEASE}.7z`, 'wrong bytes');
  seedArchive(root, 'winCodeSign-9.9.9.7z', Buffer.alloc(5 * 1024 * 1024, 2));
  const archive = seedArchive(root, 'builder-download.tmp.7z', bytes);
  const { fetchImpl, calls } = fetchReturning(Buffer.from('must not download'));

  const result = await ensurePrewarmedWinCodeSign({
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    fetchImpl,
    expectedSha512: sha512(bytes),
    platform: 'win32',
    extract: (options) => {
      assert.equal(options.archivePath, archive);
      fakeExtract()(options);
    },
    log: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(result.target, expectedWinCodeSignDir(root));
  assert.equal(isPrewarmed(result.target, sha512(bytes)), true);
  assert.equal(calls.length, 0);
});

test('ensurePrewarmedWinCodeSign downloads when cached bytes are untrusted', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('downloaded verified bytes');
  seedArchive(root, `${RELEASE}.7z`, 'corrupt cache bytes');
  const { fetchImpl, calls } = fetchReturning(bytes);

  const result = await ensurePrewarmedWinCodeSign({
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    fetchImpl,
    expectedSha512: sha512(bytes),
    platform: 'win32',
    extract: fakeExtract(),
    log: () => {},
  });

  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  assert.equal(isPrewarmed(result.target, sha512(bytes)), true);
});

test('a digest mismatch fails without publishing a builder-visible target', async (t) => {
  const root = tempRoot(t);
  const { fetchImpl } = fetchReturning(Buffer.from('tampered bytes'));

  await assert.rejects(
    ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      sevenZipPath: stubSevenZip(root),
      fetchImpl,
      expectedSha512: sha512(Buffer.from('expected bytes')),
      platform: 'win32',
      extract: fakeExtract(),
      log: () => {},
    }),
    /digest mismatch/,
  );

  assert.equal(existsSync(expectedWinCodeSignDir(root)), false);
  assert.deepEqual(
    readdirSync(join(root, 'winCodeSign')).filter((name) => name.endsWith('.7z')),
    [],
    'a mismatched download must not be cached',
  );
});

test('an untrusted cache plus a failing download leaves no target', async (t) => {
  const root = tempRoot(t);
  seedArchive(root, `${RELEASE}.7z`, 'corrupt cache bytes');
  const { fetchImpl } = fetchReturning(Buffer.from('also wrong'));

  await assert.rejects(
    ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      sevenZipPath: stubSevenZip(root),
      fetchImpl,
      expectedSha512: sha512(Buffer.from('expected bytes')),
      platform: 'win32',
      extract: fakeExtract(),
      log: () => {},
    }),
    /digest mismatch/,
  );

  assert.equal(existsSync(expectedWinCodeSignDir(root)), false);
});

test('an extraction without the Windows tools does not publish a target', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('verified archive bytes');
  seedArchive(root, `${RELEASE}.7z`, bytes);
  seedArchive(root, 'decoy.txt', 'not an archive');

  await assert.rejects(
    ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      sevenZipPath: stubSevenZip(root),
      expectedSha512: sha512(bytes),
      platform: 'win32',
      extract: () => {},
      log: () => {},
    }),
    /did not produce the Windows tools/,
  );

  assert.equal(existsSync(expectedWinCodeSignDir(root)), false);
  assert.deepEqual(
    readdirSync(join(root, 'winCodeSign')).filter((name) => name.startsWith('.extract-')),
    [],
  );
});

test('ensurePrewarmedWinCodeSign is idempotent after a verified prewarm', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('verified archive bytes');
  seedArchive(root, `${RELEASE}.7z`, bytes);
  const options = {
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    expectedSha512: sha512(bytes),
    platform: 'win32',
    extract: fakeExtract(),
    log: () => {},
  };
  await ensurePrewarmedWinCodeSign(options);

  const second = await ensurePrewarmedWinCodeSign({
    ...options,
    fetchImpl: async () => {
      throw new Error('must not download when prewarmed');
    },
  });
  assert.equal(second.skipped, true);
  assert.equal(readFileSync(join(second.target, PREWARM_MARKER), 'utf8').includes(RELEASE), true);
});

test('does not delete a builder-owned valid target without a prewarm marker', async (t) => {
  const root = tempRoot(t);
  const target = expectedWinCodeSignDir(root);
  mkdirSync(join(target, 'windows-10', 'x64'), { recursive: true });
  writeFileSync(join(target, 'rcedit-x64.exe'), 'builder-rcedit');
  writeFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), 'builder-signtool');

  const result = await ensurePrewarmedWinCodeSign({
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    expectedSha512: WIN_CODE_SIGN_SHA512,
    platform: 'win32',
    extract: () => {
      throw new Error('must not extract over builder-owned tools');
    },
    log: () => {},
  });

  assert.equal(result.skipped, true);
  assert.equal(readFileSync(join(target, 'rcedit-x64.exe'), 'utf8'), 'builder-rcedit');
  assert.equal(readFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), 'utf8'), 'builder-signtool');
});

test('an active lock older than the timeout is not stolen', async (t) => {
  const root = tempRoot(t);
  const cacheDir = join(root, 'winCodeSign');
  const lockDir = join(cacheDir, '.prewarm-publish.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active-owner' }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lockDir, old, old);

  await assert.rejects(
    ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      sevenZipPath: stubSevenZip(root),
      expectedSha512: WIN_CODE_SIGN_SHA512,
      platform: 'win32',
      lockTimeoutMs: 80,
      extract: () => {
        throw new Error('must not extract while another live owner holds the lock');
      },
      log: () => {},
    }),
    /timed out waiting for winCodeSign publish lock/,
  );

  assert.equal(existsSync(lockDir), true);
  assert.equal(readFileSync(join(lockDir, 'owner.json'), 'utf8').includes('active-owner'), true);
});

test('a dead owner lock is not auto-recovered and is preserved for manual cleanup', async (t) => {
  const root = tempRoot(t);
  const cacheDir = join(root, 'winCodeSign');
  const lockDir = join(cacheDir, '.prewarm-publish.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, token: 'dead-owner' }));
  const bytes = Buffer.from('verified archive bytes');
  seedArchive(root, `${RELEASE}.7z`, bytes);

  await assert.rejects(
    ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      sevenZipPath: stubSevenZip(root),
      expectedSha512: sha512(bytes),
      platform: 'win32',
      lockTimeoutMs: 80,
      extract: () => {
        throw new Error('must not extract while the stale lock is present');
      },
      log: () => {},
    }),
    /timed out waiting for winCodeSign publish lock.*remove it/,
  );

  assert.equal(existsSync(lockDir), true);
  assert.equal(readFileSync(join(lockDir, 'owner.json'), 'utf8').includes('dead-owner'), true);
  assert.equal(existsSync(expectedWinCodeSignDir(root)), false);
});

test('two cold-cache callers share one stable archive and publish once', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('verified archive bytes');
  let fetchCalls = 0;
  let onFetchStarted;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    onFetchStarted = resolve;
  });
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const fetchImpl = async () => {
    fetchCalls++;
    onFetchStarted();
    await fetchGate;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const options = {
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    expectedSha512: sha512(bytes),
    platform: 'win32',
    fetchImpl,
    extract: fakeExtract(),
    log: () => {},
  };

  const first = ensurePrewarmedWinCodeSign(options);
  await fetchStarted;
  const second = ensurePrewarmedWinCodeSign(options);
  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.skipped, false);
  assert.equal(secondResult.skipped, true);
  assert.equal(fetchCalls, 1);
  assert.equal(isPrewarmed(expectedWinCodeSignDir(root), sha512(bytes)), true);
});

test('concurrent prewarm keeps the first published target instead of deleting it', async (t) => {
  const root = tempRoot(t);
  const bytes = Buffer.from('verified archive bytes');
  seedArchive(root, `${RELEASE}.7z`, bytes);
  const target = expectedWinCodeSignDir(root);
  let extractCount = 0;
  let releaseFirstExtract;
  let releaseSecondExtract;
  const firstExtractStarted = new Promise((resolve) => {
    releaseFirstExtract = resolve;
  });
  const firstPublished = new Promise((resolve) => {
    releaseSecondExtract = resolve;
  });

  const extract = async ({ outputDir }) => {
    const call = ++extractCount;
    mkdirSync(join(outputDir, 'windows-10', 'x64'), { recursive: true });
    writeFileSync(join(outputDir, 'rcedit-x64.exe'), `rcedit-${call}`);
    writeFileSync(join(outputDir, 'windows-10', 'x64', 'signtool.exe'), `signtool-${call}`);
    if (call === 1) {
      releaseFirstExtract();
    } else {
      await firstPublished;
    }
  };

  const options = {
    cacheRoot: root,
    sevenZipPath: stubSevenZip(root),
    expectedSha512: sha512(bytes),
    platform: 'win32',
    extract,
    log: () => {},
  };

  const first = ensurePrewarmedWinCodeSign(options);
  await firstExtractStarted;
  const second = ensurePrewarmedWinCodeSign(options);
  const firstResult = await first;
  releaseSecondExtract();
  const secondResult = await second;

  assert.equal(firstResult.skipped, false);
  assert.equal(secondResult.skipped, true);
  assert.equal(readFileSync(join(target, 'rcedit-x64.exe'), 'utf8'), 'rcedit-1');
  assert.equal(readFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), 'utf8'), 'signtool-1');
});
