import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = path.resolve(process.cwd(), 'scripts/pre-merge-gate-guard.mjs');

function runGuard(tempDir, args, env = {}) {
  const psFixture = path.join(tempDir, 'ps.txt');
  const lsofFixture = path.join(tempDir, 'lsof.txt');
  const redisConfigFixture = path.join(tempDir, 'redis-config.txt');
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

  it('fails fast on high fseventsd RSS and does not leave a lock', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(path.join(tempDir, 'ps.txt'), '318 1 5000000 /System/Library/PrivateFrameworks/fseventsd\n');
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        CAT_CAFE_FSEVENTSD_RSS_MAX_KB: '1000',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /fseventsd RSS/);
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
    // Simulate another pnpm gate running in a different worktree (different PID).
    // Gates run in parallel safely: no shared writable state (git objects are
    // content-addressable/immutable, pnpm store writes are atomic hard-links,
    // node_modules/dist/.next are per-worktree). Resource pressure has its own
    // independent valves (fseventsd RSS + redis orphan checks), so a concurrent
    // gate must NOT hard-block the worktree — it only warns. (#1912 added the
    // HARD_BLOCK as incident-era over-defense with zero independent protection.)
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
      // Should succeed (soft warning, not hard block)
      assert.equal(result.status, 0, `expected success but got: ${result.stderr}`);
      assert.equal(existsSync(lockDir), true);
      assert.match(result.stderr, /concurrent gate/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('never hard-blocks regardless of how many concurrent gates are running', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // Two other gates in flight: a `pnpm gate` and a raw `pre-merge-check.sh`.
    // Both concurrent-gate patterns must downgrade to warnings, never failures.
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
      assert.match(result.stderr, /concurrent gate/);

      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not shutdown non-owned orphan Redis (CONFIG paths are not Cat Cafe test dirs)', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // Fake redis-cli that logs all calls — lets us assert shutdown was NOT called.
    const fakeBinDir = path.join(tempDir, 'bin');
    mkdirSync(fakeBinDir);
    const redisCliLog = path.join(tempDir, 'redis-cli.log');
    writeFileSync(path.join(fakeBinDir, 'redis-cli'), `#!/bin/bash\necho "$@" >> "${redisCliLog}"\n`, { mode: 0o755 });
    writeFileSync(
      path.join(tempDir, 'ps.txt'),
      `1 0 16016 /System/Library/PrivateFrameworks/fseventsd\n${process.pid} 1 100 node\n101 1 4096 redis-server 127.0.0.1:63552\n`,
    );
    writeFileSync(
      path.join(tempDir, 'lsof.txt'),
      [
        'redis-ser 100 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:6399 (LISTEN)',
        'redis-ser 101 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:63552 (LISTEN)',
      ].join('\n'),
    );
    writeFileSync(
      path.join(tempDir, 'redis-config.txt'),
      'dir\n/usr/local/var/db/redis\npidfile\n/var/run/redis.pid\nlogfile\n/var/log/redis.log\n',
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /port 63552/);
      // Critical safety assertion: redis-cli was NOT called with shutdown
      const log = existsSync(redisCliLog) ? readFileSync(redisCliLog, 'utf8') : '';
      assert.doesNotMatch(log, /shutdown/, 'non-owned Redis must NOT receive shutdown');
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does shutdown owned orphan Redis (CONFIG paths match Cat Cafe test dirs)', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    // Fake redis-cli that logs calls — lets us assert shutdown WAS called.
    const fakeBinDir = path.join(tempDir, 'bin');
    mkdirSync(fakeBinDir);
    const redisCliLog = path.join(tempDir, 'redis-cli.log');
    writeFileSync(path.join(fakeBinDir, 'redis-cli'), `#!/bin/bash\necho "$@" >> "${redisCliLog}"\n`, { mode: 0o755 });
    writeFileSync(
      path.join(tempDir, 'ps.txt'),
      `1 0 16016 /System/Library/PrivateFrameworks/fseventsd\n${process.pid} 1 100 node\n101 1 4096 redis-server 127.0.0.1:63552\n`,
    );
    writeFileSync(
      path.join(tempDir, 'lsof.txt'),
      [
        'redis-ser 100 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:6399 (LISTEN)',
        'redis-ser 101 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:63552 (LISTEN)',
      ].join('\n'),
    );
    writeFileSync(
      path.join(tempDir, 'redis-config.txt'),
      [
        'dir',
        '',
        'pidfile',
        '/tmp/claude-501/cat-cafe-rdb-first-start-XXXXXX/redis-data/redis-63552.pid',
        'logfile',
        '/tmp/claude-501/cat-cafe-rdb-first-start-XXXXXX/redis-data/redis-63552.log',
      ].join('\n'),
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)], {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      });
      // Gate still fails (fixture static, orphan "survives"), but shutdown WAS attempted
      assert.notEqual(result.status, 0);
      // Critical behavior assertion: redis-cli WAS called with shutdown for owned Redis
      const log = existsSync(redisCliLog) ? readFileSync(redisCliLog, 'utf8') : '';
      assert.match(log, /shutdown/, 'owned Redis must receive shutdown attempt');
      assert.match(log, /63552/, 'shutdown must target the orphan port');
      assert.equal(existsSync(lockDir), false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not flag protected sanctuary ports 6398/6399/6401 as orphans', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gate-guard-test-'));
    const lockDir = path.join(tempDir, 'pre-merge-check.lock');
    writeFileSync(
      path.join(tempDir, 'lsof.txt'),
      [
        'redis-ser 100 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:6398 (LISTEN)',
        'redis-ser 101 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:6399 (LISTEN)',
        'redis-ser 102 user 6u IPv4 0x0 0t0 TCP 127.0.0.1:6401 (LISTEN)',
      ].join('\n'),
    );
    try {
      const result = runGuard(tempDir, ['acquire', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(lockDir), true);
      const release = runGuard(tempDir, ['release', '--lock-dir', lockDir, '--holder-pid', String(process.pid)]);
      assert.equal(release.status, 0, release.stderr);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
