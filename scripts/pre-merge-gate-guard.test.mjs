import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = path.resolve(process.cwd(), 'scripts/pre-merge-gate-guard.mjs');

function runGuard(tempDir, args, env = {}) {
  const psFixture = path.join(tempDir, 'ps.txt');
  const lsofFixture = path.join(tempDir, 'lsof.txt');
  const redisConfigFixture = path.join(tempDir, 'redis-config.txt');
  const memoryPressureFixture = path.join(tempDir, 'memory-pressure.txt');
  if (!existsSync(psFixture)) {
    writeFileSync(psFixture, `1 0 16016 /System/Library/PrivateFrameworks/fseventsd\n${process.pid} 1 100 node\n`);
  }
  if (!existsSync(lsofFixture)) {
    writeFileSync(lsofFixture, '');
  }
  if (!existsSync(redisConfigFixture)) {
    // Default: non-owned Redis (Phase 1 won't auto-clean)
    writeFileSync(
      redisConfigFixture,
      'dir\n/usr/local/var/db/redis\npidfile\n/var/run/redis.pid\nlogfile\n/var/log/redis.log\n',
    );
  }
  if (!existsSync(memoryPressureFixture)) {
    writeFileSync(memoryPressureFixture, 'System-wide memory free percentage: 93%\n');
  }

  // Strip SKIP_PRESSURE from parent env so tests exercise actual pressure checks
  const { CAT_CAFE_GATE_GUARD_SKIP_PRESSURE: _, ...cleanEnv } = process.env;

  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      CAT_CAFE_GATE_GUARD_PS_FIXTURE: psFixture,
      CAT_CAFE_GATE_GUARD_LSOF_FIXTURE: lsofFixture,
      CAT_CAFE_GATE_GUARD_REDIS_CONFIG_FIXTURE: redisConfigFixture,
      CAT_CAFE_GATE_GUARD_MEMORY_PRESSURE_FIXTURE: memoryPressureFixture,
      CAT_CAFE_REDIS_TEST_REGISTRY_DIR: path.join(tempDir, 'redis-test-registry'),
      ...env,
    },
  });
}

describe('pre-merge gate guard', () => {
  it('blocks a second gate while the holder pid is still alive', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    try {
      const first = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(existsSync(lockDir), true);

      const second = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /already running/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks elevated fseventsd RSS when active CPU is paired with a material memory share', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(path.join(tempDir, 'ps.txt'), '318 1 5000000 100.0 /System/Library/PrivateFrameworks/fseventsd\n');
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        CAT_CAFE_FSEVENTSD_RSS_MAX_KB: '1000',
        CAT_CAFE_GATE_GUARD_TOTAL_MEMORY_KB_FIXTURE: '50000000',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fseventsd RSS/);
      assert.match(result.stderr, /pnpm process:doctor/);
      assert.match(result.stderr, /pnpm process:cleanup/);
      assert.match(result.stderr, /stale\/no-listener Clowder AI dev\/watch process groups/);
      assert.match(result.stderr, /will not necessarily reduce fseventsd RSS/);
      assert.match(result.stderr, /Manual gate bypass is a operator override/);
      assert.doesNotMatch(result.stderr, /kill -9|pkill|lsof -ti tcp:/);
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('warns but allows inflated idle fseventsd when system memory is healthy', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(path.join(tempDir, 'ps.txt'), '318 1 5000000 0.0 /System/Library/PrivateFrameworks/fseventsd\n');
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        CAT_CAFE_FSEVENTSD_RSS_MAX_KB: '1000',
        CAT_CAFE_GATE_GUARD_TOTAL_MEMORY_KB_FIXTURE: '50000000',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /fseventsd RSS/);
      assert.match(result.stderr, /advisory threshold/);
      assert.match(result.stderr, /gate allowed/);
      assert.equal(existsSync(lockDir), true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks idle fseventsd when RSS reaches a critical share of total memory', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(path.join(tempDir, 'ps.txt'), '318 1 2500000 0.0 /System/Library/PrivateFrameworks/fseventsd\n');
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        CAT_CAFE_FSEVENTSD_RSS_MAX_KB: '1000',
        CAT_CAFE_GATE_GUARD_TOTAL_MEMORY_KB_FIXTURE: '10000000',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /25\.0% of system memory/);
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('blocks elevated idle fseventsd when system memory is constrained', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(path.join(tempDir, 'ps.txt'), '318 1 5000000 0.0 /System/Library/PrivateFrameworks/fseventsd\n');
    writeFileSync(path.join(tempDir, 'memory-pressure.txt'), 'System-wide memory free percentage: 5%\n');
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        CAT_CAFE_FSEVENTSD_RSS_MAX_KB: '1000',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /system memory free 5%/);
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits soft warning for sync-to-opensource but still acquires lock', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // Simulate sync-to-opensource.sh running (different PID than holder)
    writeFileSync(
      path.join(tempDir, 'ps.txt'),
      [
        `1 0 16016 /System/Library/PrivateFrameworks/fseventsd`,
        `${process.pid} 1 100 node`,
        `99999 1 200 bash scripts/sync-to-opensource.sh --dry-run`,
      ].join('\n'),
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      // Should succeed (soft warning, not hard block)
      assert.equal(result.status, 0, `expected success but got: ${result.stderr}`);
      assert.equal(existsSync(lockDir), true);
      // Warning should appear in stderr
      assert.match(result.stderr, /concurrent resource-intensive process/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits a soft warning for a concurrent gate but still acquires the lock', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // Simulate an unre-based gate running in a different worktree. The canonical
    // wrapper queues current gates before this guard; the process scan remains an
    // advisory compatibility signal and must not revive the old fail-fast.
    writeFileSync(
      path.join(tempDir, 'ps.txt'),
      [
        `1 0 16016 /System/Library/PrivateFrameworks/fseventsd`,
        `${process.pid} 1 100 node`,
        `99998 1 200 node pnpm gate`,
      ].join('\n'),
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      // The shared wrapper owns serialization; this inner guard only warns.
      assert.equal(result.status, 0, `expected success but got: ${result.stderr}`);
      assert.equal(existsSync(lockDir), true);
      assert.match(result.stderr, /concurrent or queued gate/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never revives fail-fast for queued or unre-based gate processes', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // These may be current waiters or unre-based gates. Process names alone cannot
    // decide; the shared lease is the hard coordination mechanism.
    writeFileSync(
      path.join(tempDir, 'ps.txt'),
      [
        `1 0 16016 /System/Library/PrivateFrameworks/fseventsd`,
        `${process.pid} 1 100 node`,
        `99998 1 200 node pnpm gate`,
        `99997 1 200 bash scripts/pre-merge-check.sh`,
      ].join('\n'),
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(result.status, 0, `expected success but got: ${result.stderr}`);
      assert.equal(existsSync(lockDir), true);
      assert.match(result.stderr, /concurrent or queued gate/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
