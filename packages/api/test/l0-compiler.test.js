/**
 * F203 Phase C — Task 3a: shared L0 compile boundary helper.
 *
 * API build artefact cannot in-process import scripts/compile-system-prompt-l0.mjs
 * (the .mjs hardcodes `import('../packages/api/dist/...')`). The boundary is a
 * subprocess to the Phase B CLI. This helper is the single source for that
 * boundary; both ClaudeBgCarrierService (--system-prompt-file) and
 * CodexAgentService (-c developer_instructions) consume it.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  clearL0Cache,
  compileL0ViaSubprocess,
  resolveL0CompilerScriptPath,
} from '../dist/domains/cats/services/agents/providers/l0-compiler.js';

const SCRIPT_REL = 'scripts/compile-system-prompt-l0.mjs';

/** Mimic the real compile CLI's `writeL0File` when --out is present. */
function maybeWriteOut(args, writeOut) {
  if (writeOut == null) return;
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1], writeOut, 'utf8');
}

/**
 * Fake spawn capturing (cmd, args, opts). Emits configured stdout/stderr then
 * 'close' exitCode. If writeOut is set, writes that content to the --out path.
 */
function buildFakeSpawn({ stdout = '', stderr = '', exitCode = 0, errorOnSpawn = null, writeOut = null }) {
  const fn = function fakeSpawn(cmd, args, opts) {
    fn.calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (errorOnSpawn) {
        child.emit('error', errorOnSpawn);
        return;
      }
      maybeWriteOut(args, writeOut);
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

// --- resolveL0CompilerScriptPath ---

test('resolveL0CompilerScriptPath finds script when cwd is repo root', () => {
  const root = mkdtempSync(join(tmpdir(), 'l0-root-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  assert.equal(resolveL0CompilerScriptPath(root), resolve(root, SCRIPT_REL));
});

test('resolveL0CompilerScriptPath finds script when cwd is packages/api', () => {
  const root = mkdtempSync(join(tmpdir(), 'l0-pkgapi-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages', 'api'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  assert.equal(resolveL0CompilerScriptPath(join(root, 'packages', 'api')), resolve(root, SCRIPT_REL));
});

test('resolveL0CompilerScriptPath: cwd with no script falls back to install root', () => {
  const empty = mkdtempSync(join(tmpdir(), 'l0-empty-'));
  const result = resolveL0CompilerScriptPath(empty);
  // In monorepo, deriveInstallRoot() resolves the real script via import.meta.url.
  // Outside monorepo (e.g. consumer package), this would return undefined.
  if (result !== undefined) {
    assert.match(result, /compile-system-prompt-l0\.mjs$/);
  }
});

// --- compileL0ViaSubprocess ---

function seedRepoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'l0-repo-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  return root;
}

test('compileL0ViaSubprocess (no outPath) returns stdout as compiled L0', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: '你是 布偶猫（Claude Opus）...L0 BODY...' });
  const out = await compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.match(out, /布偶猫/);
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [
    resolve(root, SCRIPT_REL),
    '--cat',
    'opus-47',
    '--profile-dir',
    resolve(root, 'private/profile'),
  ]);
  assert.ok(!call.args.includes('--out'), 'no --out when outPath omitted');
});

test('compileL0ViaSubprocess (outPath) passes --out and returns file content', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const outPath = join(mkdtempSync(join(tmpdir(), 'l0-out-')), 'system-prompt-l0.md');
  const spawnFn = buildFakeSpawn({ stderr: `Wrote compiled L0 → ${outPath}`, writeOut: 'COMPILED-L0-FILE-CONTENT' });
  const out = await compileL0ViaSubprocess({ catId: 'codex', cwd: root, outPath, spawnFn });
  assert.equal(out, 'COMPILED-L0-FILE-CONTENT');
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [
    resolve(root, SCRIPT_REL),
    '--cat',
    'codex',
    '--profile-dir',
    resolve(root, 'private/profile'),
    '--out',
    outPath,
  ]);
});

test('compileL0ViaSubprocess fail-closed: unresolvable script path throws', async () => {
  clearL0Cache();
  const empty = mkdtempSync(join(tmpdir(), 'l0-noscript-'));
  await assert.rejects(
    () => compileL0ViaSubprocess({ catId: 'no-script-cat', cwd: empty, spawnFn: buildFakeSpawn({}) }),
    // Without install-root fallback: "script not resolvable" error.
    // With install-root (monorepo): script found → fakeSpawn({}) returns empty → "empty output" error.
    /compile-system-prompt-l0|script.*not.*resolve|L0 compiler|empty/i,
  );
});

test('compileL0ViaSubprocess fail-closed: non-zero exit throws with stderr', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ exitCode: 2, stderr: 'unknown catId "ghost"' });
  await assert.rejects(
    () => compileL0ViaSubprocess({ catId: 'ghost', cwd: root, spawnFn }),
    (err) => {
      assert.match(err.message, /ghost|exit|2/);
      return true;
    },
  );
});

test('compileL0ViaSubprocess fail-closed: empty stdout (no outPath) throws', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: '   \n' });
  await assert.rejects(() => compileL0ViaSubprocess({ catId: 'empty-cat', cwd: root, spawnFn }), /empty|no.*output/i);
});

test('compileL0ViaSubprocess fail-closed: spawn error (ENOENT) throws', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ errorOnSpawn: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(() => compileL0ViaSubprocess({ catId: 'enoent-cat', cwd: root, spawnFn }), /ENOENT|spawn/i);
});

// --- L0 cache ---

test('compileL0ViaSubprocess caches result and clearL0Cache invalidates', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: 'CACHED L0 CONTENT' });

  // First call: subprocess runs
  const out1 = await compileL0ViaSubprocess({ catId: 'cache-test-cat', cwd: root, spawnFn });
  assert.equal(out1, 'CACHED L0 CONTENT');
  assert.equal(spawnFn.calls.length, 1);

  // Second call: cache hit, no new subprocess
  const out2 = await compileL0ViaSubprocess({ catId: 'cache-test-cat', cwd: root, spawnFn });
  assert.equal(out2, 'CACHED L0 CONTENT');
  assert.equal(spawnFn.calls.length, 1, 'cache hit should skip subprocess');

  // Clear single cat: next call should spawn again
  clearL0Cache('cache-test-cat');
  const spawnFn2 = buildFakeSpawn({ stdout: 'REFRESHED L0' });
  const out3 = await compileL0ViaSubprocess({ catId: 'cache-test-cat', cwd: root, spawnFn: spawnFn2 });
  assert.equal(out3, 'REFRESHED L0');
  assert.equal(spawnFn2.calls.length, 1);
});

// --- F231: profileDir cwd-first resolution (gpt52 封板 review) ---

test('F231: profileDir prefers cwd/private/profile when it exists (packaged install scenario)', async () => {
  clearL0Cache();
  // Simulate packaged install: cwd (project dir) has private/profile/,
  // but scripts/ lives elsewhere (install dir).
  const projectDir = mkdtempSync(join(tmpdir(), 'l0-project-'));
  const installDir = mkdtempSync(join(tmpdir(), 'l0-install-'));

  // Install dir has the compile script
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  writeFileSync(join(installDir, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');

  // Project dir has private/profile/ (user data)
  mkdirSync(join(projectDir, 'private', 'profile'), { recursive: true });

  // Symlink scripts into project dir so resolveL0CompilerScriptPath can find it from cwd
  // (in real packaged install, this would be an NTFS junction — but cwd-based candidate
  // would find it. The key is that profileDir should prefer projectDir.)
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  writeFileSync(join(projectDir, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');

  const spawnFn = buildFakeSpawn({ stdout: 'PACKAGED-L0' });
  await compileL0ViaSubprocess({ catId: 'packaged-cat', cwd: projectDir, spawnFn });
  const call = spawnFn.calls[0];
  // profileDir should be project dir (cwd), not install dir
  assert.equal(
    call.args[call.args.indexOf('--profile-dir') + 1],
    resolve(projectDir, 'private/profile'),
    'profileDir must prefer cwd-based path when private/profile/ exists at cwd',
  );
});

test('F231: profileDir falls back to script-path-based when cwd has no private/profile/', async () => {
  clearL0Cache();
  // Simulate cwd=packages/api: no private/profile/ at cwd, script is at ../../scripts/
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: 'FALLBACK-L0' });
  await compileL0ViaSubprocess({ catId: 'fallback-cat', cwd: root, spawnFn });
  const call = spawnFn.calls[0];
  // Should fall back to script-path-based derivation
  assert.equal(
    call.args[call.args.indexOf('--profile-dir') + 1],
    resolve(root, 'private/profile'),
    'profileDir must fall back to script-path-based when cwd has no private/profile/',
  );
});

// --- L0 template content guard ---

test('L0 template includes limb tool quick index (via L5 segment)', () => {
  // F237: L0 template now uses {{L5_CONTENT}} placeholder; actual content lives in l5-mcp-tools-index.md
  const l5Path = resolve(import.meta.dirname, '../../../assets/prompt-templates/l5-mcp-tools-index.md');
  const content = readFileSync(l5Path, 'utf8');
  assert.match(content, /limb_list_available/, 'L5 MCP tools template must mention limb_list_available');
  assert.match(content, /limb_invoke/, 'L5 MCP tools template must mention limb_invoke');
});

// --- AC-G10 (Phase G native L0 closure / KD-44): in-flight Promise dedup ---

test('AC-G10: concurrent cold-cache compileL0ViaSubprocess calls collapse to single spawn (in-flight dedup)', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  // Slow fake spawn — emits stdout + close after a microtask delay so two
  // concurrent callers can both reach the in-flight check before settle.
  function buildSlowSpawn(stdoutPayload) {
    const fn = function fakeSpawn(cmd, args, opts) {
      fn.calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // Two-tick delay so the second caller installs await before close.
      setImmediate(() => {
        setImmediate(() => {
          child.stdout.emit('data', Buffer.from(stdoutPayload));
          child.emit('close', 0);
        });
      });
      return child;
    };
    fn.calls = [];
    return fn;
  }
  const spawnFn = buildSlowSpawn('DEDUP-L0-OUTPUT');
  const [out1, out2, out3] = await Promise.all([
    compileL0ViaSubprocess({ catId: 'dedup-cat', cwd: root, spawnFn }),
    compileL0ViaSubprocess({ catId: 'dedup-cat', cwd: root, spawnFn }),
    compileL0ViaSubprocess({ catId: 'dedup-cat', cwd: root, spawnFn }),
  ]);
  assert.equal(out1, 'DEDUP-L0-OUTPUT');
  assert.equal(out2, 'DEDUP-L0-OUTPUT');
  assert.equal(out3, 'DEDUP-L0-OUTPUT');
  assert.equal(spawnFn.calls.length, 1, 'three concurrent cold-cache calls must share one subprocess invocation');
});

test('AC-G10: post-dedup the cache holds result — subsequent calls do not respawn', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: 'CACHED-AFTER-DEDUP' });
  // Pair of concurrent calls — installs cache after settle.
  await Promise.all([
    compileL0ViaSubprocess({ catId: 'post-dedup-cat', cwd: root, spawnFn }),
    compileL0ViaSubprocess({ catId: 'post-dedup-cat', cwd: root, spawnFn }),
  ]);
  assert.equal(spawnFn.calls.length, 1);
  // Third call sequentially — must hit cache, not spawn again.
  const result = await compileL0ViaSubprocess({ catId: 'post-dedup-cat', cwd: root, spawnFn });
  assert.equal(result, 'CACHED-AFTER-DEDUP');
  assert.equal(spawnFn.calls.length, 1, 'cache hit after dedup must skip subprocess');
});

test('AC-G10: in-flight failure does not poison cache — next call may retry', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  // First spawn fails with non-zero exit.
  const failingSpawn = buildFakeSpawn({ stderr: 'first call fails', exitCode: 2 });
  await assert.rejects(
    () => compileL0ViaSubprocess({ catId: 'retry-cat', cwd: root, spawnFn: failingSpawn }),
    /retry-cat|exit|2/,
  );
  // Second spawn succeeds — confirms cache was not populated by the failure.
  const goodSpawn = buildFakeSpawn({ stdout: 'RECOVERED-L0' });
  const out = await compileL0ViaSubprocess({ catId: 'retry-cat', cwd: root, spawnFn: goodSpawn });
  assert.equal(out, 'RECOVERED-L0');
  assert.equal(goodSpawn.calls.length, 1);
});

test('AC-G10: clearL0Cache during in-flight compile prevents stale result from repopulating cache', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const pending = [];
  const controlledSpawn = function fakeSpawn(cmd, args, opts) {
    controlledSpawn.calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    pending.push(child);
    return child;
  };
  controlledSpawn.calls = [];

  const oldCompile = compileL0ViaSubprocess({ catId: 'clear-race-cat', cwd: root, spawnFn: controlledSpawn });
  assert.equal(controlledSpawn.calls.length, 1);
  assert.equal(pending.length, 1);

  clearL0Cache('clear-race-cat');

  pending[0].stdout.emit('data', Buffer.from('STALE-L0'));
  pending[0].emit('close', 0);
  assert.equal(await oldCompile, 'STALE-L0', 'the already-started caller still receives its own compile result');

  const freshSpawn = buildFakeSpawn({ stdout: 'FRESH-L0' });
  const out = await compileL0ViaSubprocess({ catId: 'clear-race-cat', cwd: root, spawnFn: freshSpawn });
  assert.equal(out, 'FRESH-L0');
  assert.equal(freshSpawn.calls.length, 1, 'post-clear caller must respawn instead of reading stale cache');
});
