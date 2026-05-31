// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { detectEnvironmentSync, getEnvironmentProfile, clearEnvironmentCache, resolveDiskProbePath } = await import(
  '../dist/domains/services/environment-detector.js'
);

describe('environment detector — shape & sanity', () => {
  test('detectEnvironmentSync returns well-formed profile', () => {
    const p = detectEnvironmentSync();
    assert.ok(['darwin', 'win32', 'linux'].includes(p.os));
    assert.ok(['arm64', 'x64'].includes(p.arch));
    assert.ok(['apple', 'cuda', 'rocm', 'none'].includes(p.gpu));
    assert.ok(['native', 'x86-emulated', 'missing'].includes(p.pythonArch));
    assert.equal(typeof p.ramGb, 'number');
    assert.ok(p.ramGb > 0);
    assert.equal(typeof p.diskFreeGb, 'number');
    assert.ok(p.diskFreeGb >= 0);
    assert.equal(typeof p.detectedAt, 'number');
  });

  test('macOS arm64 → gpu=apple', () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    const p = detectEnvironmentSync();
    assert.equal(p.os, 'darwin');
    assert.equal(p.arch, 'arm64');
    assert.equal(p.gpu, 'apple');
  });

  test('disk probe uses CAT_CAFE_HOME parent filesystem before the directory exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-home-probe-'));
    try {
      const missingHome = join(root, 'nested', '.cat-cafe');
      assert.equal(resolveDiskProbePath(missingHome, [tmpdir()]), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('environment detector — cache', () => {
  test('getEnvironmentProfile caches within TTL', () => {
    clearEnvironmentCache();
    const a = getEnvironmentProfile();
    const b = getEnvironmentProfile();
    assert.equal(a.detectedAt, b.detectedAt);
  });

  test('forceRefresh re-runs detection', async () => {
    const a = getEnvironmentProfile();
    await new Promise((r) => setTimeout(r, 10));
    const b = getEnvironmentProfile(true);
    assert.notEqual(a.detectedAt, b.detectedAt);
  });

  test('clearEnvironmentCache forces fresh detection', async () => {
    const a = getEnvironmentProfile();
    clearEnvironmentCache();
    await new Promise((r) => setTimeout(r, 10));
    const b = getEnvironmentProfile();
    assert.notEqual(a.detectedAt, b.detectedAt);
  });
});
