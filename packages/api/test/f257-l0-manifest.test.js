/**
 * F257 #2 — L0 compiler manifest boundary (foundation).
 *
 * Proves getL0ManifestViaSubprocess() sources the per-segment L1-L7 manifest from the
 * SAME subprocess compile that produces the delivered prompt string, riding the SAME
 * cache/generation lifecycle (lockstep with l0Cache), and fails open (empty manifest,
 * never a throw that would break the fail-closed string compile). Uses a fake spawn
 * that writes the --manifest-out file exactly as the real compiler CLI does.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  clearL0Cache,
  compileL0ViaSubprocess,
  getL0ManifestViaSubprocess,
} from '../dist/domains/cats/services/agents/providers/l0-compiler.js';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'l0-manifest-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'compile-system-prompt-l0.mjs'), '// fake');
  return root;
}

/**
 * Fake spawn that mimics the real CLI: writes the compiled string to --out (or
 * emits it on stdout), and writes the JSON manifest to --manifest-out.
 */
function buildManifestSpawn({ compiled = 'COMPILED-L0', manifest = [], exitCode = 0 }) {
  const fn = function fakeSpawn(cmd, args, opts) {
    fn.calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const outIdx = args.indexOf('--out');
      if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1], compiled, 'utf8');
      const mIdx = args.indexOf('--manifest-out');
      if (mIdx >= 0 && args[mIdx + 1] && manifest !== null) {
        writeFileSync(args[mIdx + 1], JSON.stringify(manifest), 'utf8');
      }
      if (outIdx < 0) child.stdout.emit('data', Buffer.from(compiled));
      child.emit('close', exitCode);
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

const L_MANIFEST = [
  { id: 'L1', content: '你不是一个孤立的工具' },
  { id: 'L2', content: '客观性 carry-over' },
  { id: 'L3', content: '传球三选一' },
  { id: 'L4', content: '五条铁律' },
  { id: 'L5', content: 'MCP 工具 index' },
  { id: 'L6', content: '能力唤醒' },
  { id: 'L7', content: '协作哲学' },
];

test('getL0ManifestViaSubprocess passes --manifest-out and returns parsed L1-L7', async () => {
  clearL0Cache();
  const root = makeRoot();
  const spawnFn = buildManifestSpawn({ compiled: 'PROMPT', manifest: L_MANIFEST });
  const manifest = await getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });

  assert.deepEqual(
    manifest.map((s) => s.segmentId),
    ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'],
  );
  assert.equal(manifest[3].content, '五条铁律');
  const call = spawnFn.calls[0];
  assert.ok(call.args.includes('--manifest-out'), 'compiler invoked with --manifest-out');
});

test('manifest rides l0Cache lockstep — string compile is a cache hit afterward', async () => {
  clearL0Cache();
  const root = makeRoot();
  const spawnFn = buildManifestSpawn({ compiled: 'PROMPT-BODY', manifest: L_MANIFEST });
  await getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  // String compile for the same cat must NOT re-spawn (both caches set together).
  const str = await compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.equal(str, 'PROMPT-BODY');
  assert.equal(spawnFn.calls.length, 1, 'only one subprocess for both string + manifest');
});

test('second manifest read is cache-first (no re-spawn)', async () => {
  clearL0Cache();
  const root = makeRoot();
  const spawnFn = buildManifestSpawn({ manifest: L_MANIFEST });
  await getL0ManifestViaSubprocess({ catId: 'codex', cwd: root, spawnFn });
  await getL0ManifestViaSubprocess({ catId: 'codex', cwd: root, spawnFn });
  assert.equal(spawnFn.calls.length, 1, 'manifest cache-first — no second spawn');
});

test('clearL0Cache drops the manifest (next read re-spawns)', async () => {
  clearL0Cache();
  const root = makeRoot();
  const spawnFn = buildManifestSpawn({ manifest: L_MANIFEST });
  await getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  clearL0Cache('opus-47');
  await getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.equal(spawnFn.calls.length, 2, 'manifest cleared with string cache — re-spawned');
});

test('fail-open: missing/garbage manifest → [] but string compile still succeeds', async () => {
  clearL0Cache();
  const root = makeRoot();
  // manifest:null → fake does not write the manifest file at all
  const spawnFn = buildManifestSpawn({ compiled: 'STILL-COMPILES', manifest: null });
  const str = await compileL0ViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.equal(str, 'STILL-COMPILES', 'critical string compile unaffected by missing manifest');
  const manifest = await getL0ManifestViaSubprocess({ catId: 'opus-47', cwd: root, spawnFn });
  assert.deepEqual(manifest, [], 'no manifest → empty (visible signal), not a throw');
});
