import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// F231: resolveProfileDir is the single source of truth shared by the L0 compiler (read capsule)
// and the profile-update routes (write primer). These tests pin the resolution rules so the two
// can never drift.
describe('resolveProfileDir (read/write path consistency)', () => {
  let tmp;
  let mod;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'f231-pdir-'));
    mod = await import('../dist/domains/cats/services/profile/profile-dir.js');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns cwd/private/profile when it exists', () => {
    mkdirSync(join(tmp, 'private', 'profile'), { recursive: true });
    assert.equal(mod.resolveProfileDir(tmp, undefined), resolve(tmp, 'private', 'profile'));
  });

  it('falls back to script-relative dir when cwd/private/profile is absent', () => {
    const scriptPath = join(tmp, 'scripts', 'compile-system-prompt-l0.mjs');
    assert.equal(mod.resolveProfileDir(tmp, scriptPath), resolve(dirname(scriptPath), '..', 'private', 'profile'));
  });

  it('returns cwd-based dir (best-effort) when absent and no scriptPath', () => {
    assert.equal(mod.resolveProfileDir(tmp, undefined), resolve(tmp, 'private', 'profile'));
  });

  it('P1: writable profile dir stays under cwd for first-ever writes', () => {
    const scriptPath = join(tmp, 'install', 'scripts', 'compile-system-prompt-l0.mjs');
    assert.equal(mod.resolveWritableProfileDir(tmp, scriptPath), resolve(tmp, 'private', 'profile'));
  });

  it('P1: writable profile dir uses an existing read profile dir before creating cwd/private/profile', () => {
    const scriptPath = join(tmp, 'install', 'scripts', 'compile-system-prompt-l0.mjs');
    const scriptProfileDir = resolve(dirname(scriptPath), '..', 'private', 'profile');
    mkdirSync(scriptProfileDir, { recursive: true });
    assert.equal(mod.resolveWritableProfileDir(tmp, scriptPath), scriptProfileDir);
  });
});
