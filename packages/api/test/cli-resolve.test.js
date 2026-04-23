import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { resolveCliCommand, resolveCliCommandOrBare, formatCliNotFoundError } = await import(
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
