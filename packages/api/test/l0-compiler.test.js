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
  mkdirSync(join(root, 'assets', 'system-prompts'), { recursive: true });
  mkdirSync(join(root, 'assets', 'prompt-templates'), { recursive: true });
  mkdirSync(join(root, 'cat-cafe-skills', 'refs'), { recursive: true });
  writeFileSync(join(root, 'assets', 'system-prompts', 'system-prompt-l0.md'), 'BASE L0 TEMPLATE');
  writeFileSync(join(root, 'assets', 'prompt-templates', 'l5-mcp-tools-index.md'), 'INITIAL L5');
  writeFileSync(join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md'), 'INITIAL GOVERNANCE RULES');
  return root;
}

test('compileL0ViaSubprocess (no outPath) returns stdout as compiled L0', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: '你是 布偶猫（Claude Opus）...L0 BODY...' });
  const out = await compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, dataDir: root, spawnFn });
  assert.match(out, /布偶猫/);
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [
    resolve(root, SCRIPT_REL),
    '--cat',
    'opus-47',
    '--profile-dir',
    resolve(root, 'profiles/default-user'),
  ]);
  assert.ok(!call.args.includes('--out'), 'no --out when outPath omitted');
});

test('F231: canonical profileDir is user-scoped and independent of compiler cwd', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const dataDir = mkdtempSync(join(tmpdir(), 'f231-canonical-data-'));
  const spawnFn = buildFakeSpawn({ stdout: 'USER-SCOPED-L0' });

  await compileL0ViaSubprocess({ catId: 'codex', userId: 'alice', cwd: root, dataDir, spawnFn });

  const call = spawnFn.calls[0];
  assert.equal(call.args[call.args.indexOf('--profile-dir') + 1], resolve(dataDir, 'profiles', 'alice'));
});

test('F231: L0 cache key isolates users with the same catId', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const dataDir = mkdtempSync(join(tmpdir(), 'f231-cache-data-'));
  const aliceSpawn = buildFakeSpawn({ stdout: 'ALICE-L0' });
  const bobSpawn = buildFakeSpawn({ stdout: 'BOB-L0' });

  assert.equal(
    await compileL0ViaSubprocess({ catId: 'codex', userId: 'alice', cwd: root, dataDir, spawnFn: aliceSpawn }),
    'ALICE-L0',
  );
  assert.equal(
    await compileL0ViaSubprocess({ catId: 'codex', userId: 'bob', cwd: root, dataDir, spawnFn: bobSpawn }),
    'BOB-L0',
  );
  assert.equal(aliceSpawn.calls.length, 1);
  assert.equal(bobSpawn.calls.length, 1, 'bob must not receive alice cache entry');
});

test('compileL0ViaSubprocess (outPath) passes --out and returns file content', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const outPath = join(mkdtempSync(join(tmpdir(), 'l0-out-')), 'system-prompt-l0.md');
  const spawnFn = buildFakeSpawn({ stderr: `Wrote compiled L0 → ${outPath}`, writeOut: 'COMPILED-L0-FILE-CONTENT' });
  const out = await compileL0ViaSubprocess({ catId: 'codex', cwd: root, dataDir: root, outPath, spawnFn });
  assert.equal(out, 'COMPILED-L0-FILE-CONTENT');
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [
    resolve(root, SCRIPT_REL),
    '--cat',
    'codex',
    '--profile-dir',
    resolve(root, 'profiles/default-user'),
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

test('compileL0ViaSubprocess invalidates cached L0 when prompt-template assets change', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const l5TemplatePath = join(root, 'assets', 'prompt-templates', 'l5-mcp-tools-index.md');
  const spawnFn = buildFakeSpawn({ stdout: 'L0 BEFORE TEMPLATE CHANGE' });

  const out1 = await compileL0ViaSubprocess({ catId: 'template-change-cat', cwd: root, spawnFn });
  assert.equal(out1, 'L0 BEFORE TEMPLATE CHANGE');
  assert.equal(spawnFn.calls.length, 1);

  writeFileSync(l5TemplatePath, 'UPDATED L5 WITH PROJECTPATH GUARD CONTENT');

  const spawnFn2 = buildFakeSpawn({ stdout: 'L0 AFTER TEMPLATE CHANGE' });
  const out2 = await compileL0ViaSubprocess({ catId: 'template-change-cat', cwd: root, spawnFn: spawnFn2 });
  assert.equal(out2, 'L0 AFTER TEMPLATE CHANGE');
  assert.equal(spawnFn2.calls.length, 1, 'template changes must force a fresh L0 compiler subprocess');
});

test('compileL0ViaSubprocess invalidates cached L0 when governance rules change', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const sharedRulesPath = join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md');
  const localRulesPath = join(root, 'cat-cafe-skills', 'refs', 'shared-rules.local.md');
  const overrideRulesPath = join(root, 'cat-cafe-skills', 'refs', 'shared-rules.local-override.md');
  const spawnFn = buildFakeSpawn({ stdout: 'L0 BEFORE GOVERNANCE CHANGE' });

  const out1 = await compileL0ViaSubprocess({ catId: 'governance-change-cat', cwd: root, spawnFn });
  assert.equal(out1, 'L0 BEFORE GOVERNANCE CHANGE');
  assert.equal(spawnFn.calls.length, 1);

  writeFileSync(sharedRulesPath, 'UPDATED GOVERNANCE RULES');

  const spawnFn2 = buildFakeSpawn({ stdout: 'L0 AFTER SHARED RULES CHANGE' });
  const out2 = await compileL0ViaSubprocess({ catId: 'governance-change-cat', cwd: root, spawnFn: spawnFn2 });
  assert.equal(out2, 'L0 AFTER SHARED RULES CHANGE');
  assert.equal(spawnFn2.calls.length, 1, 'shared-rules changes must force a fresh L0 compiler subprocess');

  writeFileSync(localRulesPath, 'LOCAL GOVERNANCE OVERLAY');

  const spawnFn3 = buildFakeSpawn({ stdout: 'L0 AFTER LOCAL GOVERNANCE OVERLAY' });
  const out3 = await compileL0ViaSubprocess({ catId: 'governance-change-cat', cwd: root, spawnFn: spawnFn3 });
  assert.equal(out3, 'L0 AFTER LOCAL GOVERNANCE OVERLAY');
  assert.equal(spawnFn3.calls.length, 1, 'shared-rules.local changes must force a fresh L0 compiler subprocess');

  writeFileSync(overrideRulesPath, 'LOCAL GOVERNANCE OVERRIDE');

  const spawnFn4 = buildFakeSpawn({ stdout: 'L0 AFTER LOCAL GOVERNANCE OVERRIDE' });
  const out4 = await compileL0ViaSubprocess({ catId: 'governance-change-cat', cwd: root, spawnFn: spawnFn4 });
  assert.equal(out4, 'L0 AFTER LOCAL GOVERNANCE OVERRIDE');
  assert.equal(
    spawnFn4.calls.length,
    1,
    'shared-rules.local-override changes must force a fresh L0 compiler subprocess',
  );
});

test('F231: profile content changes invalidate only that user/cat L0 cache entry', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const dataDir = mkdtempSync(join(tmpdir(), 'f231-profile-cache-'));
  const relationshipDir = join(dataDir, 'profiles', 'alice', 'relationship');
  mkdirSync(relationshipDir, { recursive: true });
  const primerPath = join(relationshipDir, 'maine-coon-primer.md');
  writeFileSync(primerPath, 'FIRST');

  const firstSpawn = buildFakeSpawn({ stdout: 'L0-FIRST' });
  assert.equal(
    await compileL0ViaSubprocess({ catId: 'codex', userId: 'alice', cwd: root, dataDir, spawnFn: firstSpawn }),
    'L0-FIRST',
  );

  writeFileSync(primerPath, 'SECOND');
  const secondSpawn = buildFakeSpawn({ stdout: 'L0-SECOND' });
  assert.equal(
    await compileL0ViaSubprocess({ catId: 'codex', userId: 'alice', cwd: root, dataDir, spawnFn: secondSpawn }),
    'L0-SECOND',
  );
  assert.equal(secondSpawn.calls.length, 1, 'profile edits must force a fresh compiler subprocess');
});

// --- F231: canonical profile root is not coupled to install/worktree layout ---

test('F231: legacy cwd/private/profile never shadows the canonical data root', async () => {
  clearL0Cache();
  const projectDir = mkdtempSync(join(tmpdir(), 'l0-project-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'l0-data-'));
  mkdirSync(join(projectDir, 'private', 'profile'), { recursive: true });
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  writeFileSync(join(projectDir, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');

  const spawnFn = buildFakeSpawn({ stdout: 'PACKAGED-L0' });
  await compileL0ViaSubprocess({ catId: 'packaged-cat', userId: 'alice', cwd: projectDir, dataDir, spawnFn });
  const call = spawnFn.calls[0];
  assert.equal(
    call.args[call.args.indexOf('--profile-dir') + 1],
    resolve(dataDir, 'profiles/alice'),
    'legacy worktree data must not shadow the canonical user root',
  );
});

test('F231: packaged script lookup and profile storage use independent roots', async () => {
  clearL0Cache();
  const root = seedRepoRoot();
  const dataDir = mkdtempSync(join(tmpdir(), 'l0-data-'));
  const spawnFn = buildFakeSpawn({ stdout: 'FALLBACK-L0' });
  await compileL0ViaSubprocess({ catId: 'fallback-cat', userId: 'alice', cwd: root, dataDir, spawnFn });
  const call = spawnFn.calls[0];
  assert.equal(
    call.args[call.args.indexOf('--profile-dir') + 1],
    resolve(dataDir, 'profiles/alice'),
    'install root must never become a profile storage fallback',
  );
});

// --- L0 template content guard ---

test('L0 template includes limb tool quick index (via L5 segment)', () => {
  // F237: L0 template now uses {{L5_CONTENT}} placeholder; actual content lives in l5-mcp-tools-index.md
  const l5Path = resolve(import.meta.dirname, '../../../assets/prompt-templates/l5-mcp-tools-index.md');
  const content = readFileSync(l5Path, 'utf8');
  assert.match(content, /limb_list_available/, 'L5 MCP tools template must mention limb_list_available');
  assert.match(content, /limb_invoke_tool/, 'L5 MCP tools template must mention limb_invoke_tool');
  assert.match(content, /cat_cafe_propose_thread/, 'L5 MCP tools template must mention propose_thread');
  assert.match(content, /cat_cafe_withdraw_thread_proposal/, 'L5 MCP tools template must mention requester withdrawal');
  assert.match(
    content,
    /(GitHub target≠projectPath|projectPath=归属≠GitHub target)/,
    'L5 MCP tools template must separate GitHub target from projectPath',
  );
  assert.match(
    content,
    /triage reportingMode=none/,
    'L5 MCP tools template must preserve PR triage reportingMode guidance',
  );
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
