/**
 * F257 #2 (2b R2 P2-1) — REAL L0 compiler ↔ manifest contract (no fake spawn).
 *
 * The unit tests use a fake spawn that assumes --manifest-out writes correct JSON; this
 * guards the actual producer so it can't silently stop writing or diverge while the unit
 * tests stay green. Proves: compileL0WithManifest emits exactly L1-L7 and each manifest
 * content appears byte-for-byte in the compiled prompt, and the CLI's --manifest-out is
 * orthogonal to --out (file + stdout modes).
 *
 * Test-data isolation (2b R2 P2-2): the compiler is ALWAYS pointed at a dedicated EMPTY
 * temp profile dir (--profile-dir / options.profileDir), so it never reads real user
 * capsule/primer data; every temp dir (profile + compile outputs) is tracked and removed.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
// packages/api/test → up 3 → repo root → scripts/compile-system-prompt-l0.mjs
const scriptPath = resolve(testDir, '..', '..', '..', 'scripts', 'compile-system-prompt-l0.mjs');
const L_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
const CAT = 'opus';

const tmpDirs = [];
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe('F257 #2 — real compiler manifest contract (2b R2 P2-1)', () => {
  let mjs;
  let profileDir;

  before(async () => {
    mjs = await import(pathToFileURL(scriptPath).href);
    // Dedicated EMPTY profile dir — isolates the compile from any real user profile data.
    profileDir = mkTmp('l0-profile-');
  });

  after(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  test('compileL0WithManifest: exactly L1-L7, each content byte-for-byte in the compiled prompt', async () => {
    const { compiled, lSegments } = await mjs.compileL0WithManifest({ catId: CAT, profileDir });
    assert.deepEqual(
      lSegments.map((s) => s.id),
      L_IDS,
      'manifest is exactly L1-L7 in canonical order',
    );
    for (const seg of lSegments) {
      assert.ok(seg.content.trim().length > 0, `${seg.id} non-blank`);
      assert.ok(compiled.includes(seg.content), `${seg.id} content appears byte-for-byte in the compiled prompt`);
    }
  });

  test('CLI --manifest-out is orthogonal to --out (file mode + stdout mode)', () => {
    const dir = mkTmp('l0-cli-');

    // File mode: --out writes the prompt, --manifest-out writes the manifest.
    const outPath = join(dir, 'prompt.md');
    const mPath = join(dir, 'manifest.json');
    execFileSync(
      process.execPath,
      [scriptPath, '--cat', CAT, '--profile-dir', profileDir, '--out', outPath, '--manifest-out', mPath],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const fileManifest = JSON.parse(readFileSync(mPath, 'utf8'));
    assert.deepEqual(
      fileManifest.map((s) => s.id),
      L_IDS,
    );
    const filePrompt = readFileSync(outPath, 'utf8');
    for (const seg of fileManifest) assert.ok(filePrompt.includes(seg.content), `${seg.id} in --out prompt`);

    // Stdout mode: no --out → prompt on stdout; --manifest-out still writes the manifest.
    const mPath2 = join(dir, 'manifest2.json');
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, '--cat', CAT, '--profile-dir', profileDir, '--manifest-out', mPath2],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const stdoutManifest = JSON.parse(readFileSync(mPath2, 'utf8'));
    assert.deepEqual(
      stdoutManifest.map((s) => s.id),
      L_IDS,
    );
    for (const seg of stdoutManifest) assert.ok(stdout.includes(seg.content), `${seg.id} in stdout prompt`);
  });
});
