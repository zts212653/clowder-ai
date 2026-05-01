#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveWorktreePorts, REDIS_SANCTUM, validateWorktreeOffset } from './derive-worktree-ports.mjs';

// ---- safety check tests ----

test('validateWorktreeOffset rejects positive offset', () => {
  assert.throws(() => validateWorktreeOffset(10), /must be ≤ 0/);
  assert.throws(() => validateWorktreeOffset(1), /must be ≤ 0/);
});

test('validateWorktreeOffset rejects offset below -100', () => {
  assert.throws(() => validateWorktreeOffset(-110), /range exceeded/);
});

test('validateWorktreeOffset rejects non-multiple-of-10', () => {
  assert.throws(() => validateWorktreeOffset(-15), /multiple of 10/);
  assert.throws(() => validateWorktreeOffset(-7), /multiple of 10/);
});

test('validateWorktreeOffset accepts 0 / -10 / -60', () => {
  assert.doesNotThrow(() => validateWorktreeOffset(0));
  assert.doesNotThrow(() => validateWorktreeOffset(-10));
  assert.doesNotThrow(() => validateWorktreeOffset(-60));
});

test('validateWorktreeOffset rejects non-integer', () => {
  assert.throws(() => validateWorktreeOffset(-10.5), /integer/);
  assert.throws(() => validateWorktreeOffset('abc'), /integer/);
  assert.throws(() => validateWorktreeOffset(NaN), /integer/);
});

// ---- 圣域 6399 sanctum ----

test('REDIS_SANCTUM constant is 6399', () => {
  assert.equal(REDIS_SANCTUM, 6399);
});

test('deriveWorktreePorts refuses to assign 6399 even via offset trick', () => {
  // offset=+1 → redis=6399 (already rejected by validateWorktreeOffset > 0)
  // No legal offset can derive 6399 since OFFSET ≤ 0 and base=6398
  // But add explicit guard in case base changes
  assert.throws(() => deriveWorktreePorts(1), /must be ≤ 0/);
});

test('deriveWorktreePorts rejects redis port < 6000 (out of safe range)', () => {
  // offset=-400 would give redis=5998, but validateWorktreeOffset rejects < -100 first
  // The < 6000 check is defense-in-depth
  assert.throws(() => deriveWorktreePorts(-400), /range exceeded/);
});

// ---- core 4 derivation ----

test('deriveWorktreePorts(0) returns alpha defaults', () => {
  const ports = deriveWorktreePorts(0);
  assert.equal(ports.redis, 6398);
  assert.equal(ports.api, 3102);
  assert.equal(ports.web, 5102);
  assert.equal(ports.nextPublicApiUrl, 'http://localhost:3102');
});

test('deriveWorktreePorts(-10) shifts core 4 correctly', () => {
  const ports = deriveWorktreePorts(-10);
  assert.equal(ports.redis, 6388, 'redis goes down (avoid 6399 sanctum)');
  assert.equal(ports.api, 3112, 'api goes up');
  assert.equal(ports.web, 5112, 'web goes up');
  assert.equal(ports.nextPublicApiUrl, 'http://localhost:3112');
});

test('deriveWorktreePorts(-60) — qwen contest slot', () => {
  const ports = deriveWorktreePorts(-60);
  assert.equal(ports.redis, 6338);
  assert.equal(ports.api, 3162);
  assert.equal(ports.web, 5162);
  assert.equal(ports.nextPublicApiUrl, 'http://localhost:3162');
});

test('deriveWorktreePorts result has only core 4 keys (sidecar not in scope)', () => {
  const ports = deriveWorktreePorts(-20);
  const keys = Object.keys(ports).sort();
  assert.deepEqual(keys, ['api', 'nextPublicApiUrl', 'redis', 'web']);
});

// ---- NEXT_PUBLIC_API_URL must be derived from API port ----

test('NEXT_PUBLIC_API_URL derived from api port (not hardcoded)', () => {
  const a = deriveWorktreePorts(-30);
  assert.equal(a.nextPublicApiUrl, `http://localhost:${a.api}`);
});

// ---- CLI malformed input tests (砚砚 review P2) ----
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'derive-worktree-ports.mjs');

function runCli(arg) {
  try {
    const out = execFileSync('node', [CLI, ...(arg === undefined ? [] : [arg])], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out.toString() };
  } catch (err) {
    return { ok: false, stderr: err.stderr?.toString() ?? '', code: err.status };
  }
}

test('CLI rejects malformed input "-10abc" (parseInt 陷阱)', () => {
  const r = runCli('-10abc');
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /有效数字|integer/i);
});

test('CLI rejects malformed input "abc"', () => {
  const r = runCli('abc');
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
});

test('CLI rejects "10.5" (non-integer)', () => {
  const r = runCli('10.5');
  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
});

test('CLI accepts no arg (offset=0)', () => {
  const r = runCli();
  assert.equal(r.ok, true);
  assert.match(r.stdout, /REDIS_PORT=6398/);
});

test('CLI accepts "-10" → offset=-10', () => {
  const r = runCli('-10');
  assert.equal(r.ok, true);
  assert.match(r.stdout, /REDIS_PORT=6388/);
  assert.match(r.stdout, /API_SERVER_PORT=3112/);
});

// ---- CLI guard regression: path with spaces (云端 Codex P1) ----
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('CLI works when script path contains spaces (P1: fileURLToPath fix)', () => {
  // 模拟云端 P1 复现场景：script 在含空格目录里
  const tmpDir = mkdtempSync(join(tmpdir(), 'derive worktree '));
  const scriptCopy = join(tmpDir, 'derive-worktree-ports.mjs');
  copyFileSync(CLI, scriptCopy);
  try {
    const out = execFileSync('node', [scriptCopy, '-10'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = out.toString();
    // 修前：CLI guard 比较失败 → 退出 0 但不输出 exports
    // 修后：fileURLToPath 转换后比较成功 → 输出 exports
    assert.match(text, /REDIS_PORT=6388/, 'CLI must output exports even when path has spaces');
    assert.match(text, /API_SERVER_PORT=3112/);
  } finally {
    // 清理临时目录
  }
});
