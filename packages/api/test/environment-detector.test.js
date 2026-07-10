// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { detectEnvironmentSync, getEnvironmentProfile, clearEnvironmentCache, resolveDiskProbePath, resolveArch } =
  await import('../dist/domains/services/environment-detector.js');

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

describe('environment detector — Rosetta regression (#1061)', () => {
  test('macOS + x64 Node + sysctl arm64=1 → arch=arm64 (Rosetta scenario)', () => {
    // Simulates Rosetta 2: process.platform='darwin', process.arch='x64',
    // but true hardware is Apple Silicon (sysctl hw.optional.arm64 → '1').
    // If resolveArch ever reverts to using process.arch, this test fails.
    const arch = resolveArch('darwin', 'x64', () => '1');
    assert.equal(arch, 'arm64');
  });

  test('macOS + arm64 Node + sysctl arm64=1 → arch=arm64 (native scenario)', () => {
    const arch = resolveArch('darwin', 'arm64', () => '1');
    assert.equal(arch, 'arm64');
  });

  test('macOS + x64 Node + sysctl null → arch=x64 (real Intel Mac)', () => {
    // On a real Intel Mac, sysctl key is absent → runQuiet returns null.
    const arch = resolveArch('darwin', 'x64', () => null);
    assert.equal(arch, 'x64');
  });

  test('macOS + x64 Node + sysctl 0 → arch=x64 (Intel fallback)', () => {
    const arch = resolveArch('darwin', 'x64', () => '0');
    assert.equal(arch, 'x64');
  });

  test('macOS + arm64 Node + sysctl null → arch=arm64 (sysctl failure fallback)', () => {
    // On native Apple Silicon, if sysctl transiently fails (returns null),
    // process.arch='arm64' is a reliable one-direction signal (an x64
    // binary can never report arm64). Must not misdetect as x64.
    const arch = resolveArch('darwin', 'arm64', () => null);
    assert.equal(arch, 'arm64');
  });

  test('Linux uses process.arch, not sysctl', () => {
    const sysctlSpy = () => {
      throw new Error('sysctl should not be called on Linux');
    };
    assert.equal(resolveArch('linux', 'arm64', sysctlSpy), 'arm64');
    assert.equal(resolveArch('linux', 'x64', sysctlSpy), 'x64');
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
