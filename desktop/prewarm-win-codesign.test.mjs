import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  ensurePrewarmedWinCodeSign,
  expectedWinCodeSignDir,
  extractionArgs,
  isPrewarmed,
  resolveCacheRoot,
  winCodeSignArchiveUrl,
} from './scripts/prewarm-win-codesign.mjs';

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
  assert.equal(expectedWinCodeSignDir(root), join(root, 'winCodeSign', 'winCodeSign-2.6.0'));
});

test('winCodeSign mirror URL keeps a trailing slash', () => {
  assert.equal(
    winCodeSignArchiveUrl({ ELECTRON_BUILDER_BINARIES_MIRROR: 'https://mirror.example/binaries' }),
    'https://mirror.example/binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
  );
});

test('extraction excludes darwin and linux symlink payloads', () => {
  const args = extractionArgs('C:\\cache\\winCodeSign.7z', 'C:\\cache\\out');
  assert.deepEqual(args, ['x', 'C:\\cache\\winCodeSign.7z', '-oC:\\cache\\out', '-x!darwin\\*', '-x!linux\\*', '-y']);
});

test('isPrewarmed requires rcedit and signtool', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-prewarm-'));
  try {
    const target = expectedWinCodeSignDir(root);
    mkdirSync(join(target, 'windows-10', 'x64'), { recursive: true });
    writeFileSync(join(target, 'rcedit-x64.exe'), '');
    assert.equal(isPrewarmed(target), false);
    writeFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), '');
    assert.equal(isPrewarmed(target), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensurePrewarmedWinCodeSign is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-prewarm-'));
  try {
    const target = expectedWinCodeSignDir(root);
    mkdirSync(join(target, 'windows-10', 'x64'), { recursive: true });
    writeFileSync(join(target, 'rcedit-x64.exe'), '');
    writeFileSync(join(target, 'windows-10', 'x64', 'signtool.exe'), '');
    const result = await ensurePrewarmedWinCodeSign({
      cacheRoot: root,
      platform: 'win32',
      fetchImpl: async () => {
        throw new Error('must not download when prewarmed');
      },
      log: () => {},
    });
    assert.equal(result.skipped, true);
    assert.equal(result.target, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
