import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { resolveCliCommand, resolveCliCommandOrBare, formatCliNotFoundError, invalidateCliCommand } = await import(
  '../dist/utils/cli-resolve.js'
);

// --- formatCliNotFoundError ---

test('formatCliNotFoundError returns install hint for known CLI', () => {
  const msg = formatCliNotFoundError('codex');
  assert.match(msg, /codex CLI 未找到/);
  assert.match(msg, /npm install -g @openai\/codex/);
});

test('formatCliNotFoundError returns generic hint for unknown CLI', () => {
  const msg = formatCliNotFoundError('unknown-tool');
  assert.match(msg, /unknown-tool CLI 未找到/);
  assert.match(msg, /install the "unknown-tool" CLI/);
});

// --- resolveCliCommandOrBare ---

test('resolveCliCommandOrBare returns bare name when CLI not found', () => {
  const result = resolveCliCommandOrBare('nonexistent-cli-tool-xyz-12345');
  assert.equal(result, 'nonexistent-cli-tool-xyz-12345');
});

// --- resolveCliCommand returns null for missing CLI ---

test('resolveCliCommand returns null for non-existent CLI', () => {
  const result = resolveCliCommand('nonexistent-cli-tool-abc-99999');
  assert.equal(result, null);
});

// --- Windows APPDATA fallback ---

test(
  'resolveCliCommand finds CLI in APPDATA/npm when not in PATH (Windows)',
  { skip: process.platform !== 'win32' && 'Windows-only (APPDATA npm fallback)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-resolve-appdata-'));
    const npmDir = join(tempRoot, 'npm');
    mkdirSync(npmDir, { recursive: true });

    // Use a unique command name that won't exist in PATH
    const cmdName = 'fake-cliresolve-test-appdata';
    const fakeCmd = join(npmDir, `${cmdName}.cmd`);
    writeFileSync(fakeCmd, '@echo off\n', 'utf8');

    const originalAppData = process.env.APPDATA;
    try {
      process.env.APPDATA = tempRoot;
      const result = resolveCliCommand(cmdName);
      assert.equal(result, fakeCmd, 'should find .cmd in APPDATA/npm');
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'resolveCliCommand finds CLI in LOCALAPPDATA/npm when APPDATA has no match (Windows)',
  { skip: process.platform !== 'win32' && 'Windows-only (LOCALAPPDATA npm fallback)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-resolve-localappdata-'));
    const emptyAppData = join(tempRoot, 'roaming');
    const localNpmDir = join(tempRoot, 'local', 'npm');
    mkdirSync(emptyAppData, { recursive: true });
    mkdirSync(localNpmDir, { recursive: true });

    const cmdName = 'fake-cliresolve-test-localappdata';
    const fakeCmd = join(localNpmDir, `${cmdName}.cmd`);
    writeFileSync(fakeCmd, '@echo off\n', 'utf8');

    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    try {
      process.env.APPDATA = emptyAppData;
      process.env.LOCALAPPDATA = join(tempRoot, 'local');
      const result = resolveCliCommand(cmdName);
      assert.equal(result, fakeCmd, 'should find .cmd in LOCALAPPDATA/npm');
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

// --- Unix HOME fallback ---

test(
  'resolveCliCommand finds CLI in HOME/.local/bin (Unix)',
  { skip: process.platform === 'win32' && 'Unix-only (HOME fallback)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-resolve-home-'));
    const localBin = join(tempRoot, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });

    const cmdName = 'fake-cliresolve-test-unix-home';
    const fakeBin = join(localBin, cmdName);
    writeFileSync(fakeBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tempRoot;
      const result = resolveCliCommand(cmdName);
      assert.equal(result, fakeBin, 'should find binary in HOME/.local/bin');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

// --- F173 Phase D AC-D1/D2: cache invalidation on stale entry ---

test(
  'resolveCliCommand auto-invalidates cached path that no longer exists (AC-D1)',
  { skip: process.platform === 'win32' && 'Unix-only fixture (HOME fallback)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-resolve-invalidate-'));
    const localBin = join(tempRoot, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });

    // Use distinct command name per run to avoid cache pollution from earlier tests
    const cmdName = `fake-stale-cli-${process.pid}-${Date.now()}`;
    const fakeBin = join(localBin, cmdName);
    writeFileSync(fakeBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tempRoot;
      const first = resolveCliCommand(cmdName);
      assert.equal(first, fakeBin, 'first resolve should populate cache');

      // Simulate binary deletion (uninstall / symlink rebuild that moved target)
      rmSync(fakeBin);

      // Without auto-invalidation this returns the stale path → caller would
      // spawn ENOENT forever until process restart.
      const second = resolveCliCommand(cmdName);
      assert.equal(second, null, 'second resolve must drop stale cache and return null');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'invalidateCliCommand accepts resolved absolute path (砚砚 P1: cli-spawn ENOENT site only has the resolved path)',
  { skip: process.platform === 'win32' && 'Unix-only fixture (HOME fallback)' },
  () => {
    // Two HOMEs: first probe finds binary at tempRootA, then we switch HOME to
    // tempRootB (empty) and call invalidate by the absolute path from tempRootA.
    // Binary at tempRootA is NOT deleted, so existsSync auto-invalidation can't
    // mask a buggy invalidate-by-path: cache hit would still return the stale path.
    const tempRootA = mkdtempSync(join(tmpdir(), 'cli-resolve-by-path-A-'));
    const tempRootB = mkdtempSync(join(tmpdir(), 'cli-resolve-by-path-B-'));
    const localBinA = join(tempRootA, '.local', 'bin');
    mkdirSync(localBinA, { recursive: true });

    const cmdName = `fake-bypath-cli-${process.pid}-${Date.now()}`;
    const fakeBinA = join(localBinA, cmdName);
    writeFileSync(fakeBinA, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tempRootA;
      assert.equal(resolveCliCommand(cmdName), fakeBinA, 'first resolve caches key=cmdName value=fakeBinA');

      // Switch HOME so re-probe would return null. Binary at tempRootA stays,
      // so existsSync(fakeBinA) on cache hit returns TRUE → cached value still
      // valid from the cache's POV. Only an actual cache delete drops it.
      process.env.HOME = tempRootB;

      // cli-spawn ENOENT site calls invalidateCliCommand(options.command) where
      // options.command is the resolved absolute path (cli-resolve cache value),
      // not the bare command name (cache key). Buggy invalidate-by-key-only would
      // silently no-op here, leaving cache stale.
      invalidateCliCommand(fakeBinA);

      assert.equal(
        resolveCliCommand(cmdName),
        null,
        'after invalidate-by-path, cache is dropped → re-probes in tempRootB → null',
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempRootA, { recursive: true, force: true });
      rmSync(tempRootB, { recursive: true, force: true });
    }
  },
);

test(
  'resolveCliCommand re-resolves after invalidateCliCommand even when cache was valid (AC-D1 explicit signal)',
  { skip: process.platform === 'win32' && 'Unix-only fixture (HOME fallback)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-resolve-explicit-invalidate-'));
    const oldBin = join(tempRoot, '.local', 'bin');
    const newBin = join(tempRoot, '.claude', 'bin');
    mkdirSync(oldBin, { recursive: true });
    mkdirSync(newBin, { recursive: true });

    const cmdName = `fake-rebuild-cli-${process.pid}-${Date.now()}`;
    const oldPath = join(oldBin, cmdName);
    const newPath = join(newBin, cmdName);
    writeFileSync(oldPath, '#!/bin/sh\necho v1\n', { mode: 0o755 });

    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tempRoot;
      assert.equal(resolveCliCommand(cmdName), oldPath, 'first resolve picks .local/bin');

      // Rebuild moves binary to a different probe directory (simulates an
      // installer migration). Without explicit invalidate, cache still serves
      // the old path even though .claude/bin would be the new truth.
      rmSync(oldPath);
      writeFileSync(newPath, '#!/bin/sh\necho v2\n', { mode: 0o755 });

      invalidateCliCommand(cmdName);
      assert.equal(resolveCliCommand(cmdName), newPath, 'after invalidate, fallback search picks .claude/bin');
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
