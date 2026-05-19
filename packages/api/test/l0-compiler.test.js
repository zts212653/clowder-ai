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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
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

test('resolveL0CompilerScriptPath returns undefined when not found', () => {
  const empty = mkdtempSync(join(tmpdir(), 'l0-empty-'));
  assert.equal(resolveL0CompilerScriptPath(empty), undefined);
});

// --- compileL0ViaSubprocess ---

function seedRepoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'l0-repo-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  return root;
}

test('compileL0ViaSubprocess (no outPath) returns stdout as compiled L0', async () => {
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: '你是 布偶猫（Claude Opus）...L0 BODY...' });
  const out = await compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.match(out, /布偶猫/);
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [resolve(root, SCRIPT_REL), '--cat', 'opus-47']);
  assert.ok(!call.args.includes('--out'), 'no --out when outPath omitted');
});

test('compileL0ViaSubprocess (outPath) passes --out and returns file content', async () => {
  const root = seedRepoRoot();
  const outPath = join(mkdtempSync(join(tmpdir(), 'l0-out-')), 'system-prompt-l0.md');
  const spawnFn = buildFakeSpawn({ stderr: `Wrote compiled L0 → ${outPath}`, writeOut: 'COMPILED-L0-FILE-CONTENT' });
  const out = await compileL0ViaSubprocess({ catId: 'codex', cwd: root, outPath, spawnFn });
  assert.equal(out, 'COMPILED-L0-FILE-CONTENT');
  const call = spawnFn.calls[0];
  assert.deepEqual(call.args, [resolve(root, SCRIPT_REL), '--cat', 'codex', '--out', outPath]);
});

test('compileL0ViaSubprocess fail-closed: unresolvable script path throws', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'l0-noscript-'));
  await assert.rejects(
    () => compileL0ViaSubprocess({ catId: 'opus-47', cwd: empty, spawnFn: buildFakeSpawn({}) }),
    /compile-system-prompt-l0|script.*not.*resolve|L0 compiler/i,
  );
});

test('compileL0ViaSubprocess fail-closed: non-zero exit throws with stderr', async () => {
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
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ stdout: '   \n' });
  await assert.rejects(() => compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn }), /empty|no.*output/i);
});

test('compileL0ViaSubprocess fail-closed: spawn error (ENOENT) throws', async () => {
  const root = seedRepoRoot();
  const spawnFn = buildFakeSpawn({ errorOnSpawn: Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(() => compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn }), /ENOENT|spawn/i);
});
