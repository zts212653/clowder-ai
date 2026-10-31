import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// F231: deprecated adapters must retain the canonical repository topology. They deliberately do
// not inspect cwd, script roots, or legacy private/profile trees.
describe('resolveProfileDir (read/write path consistency)', () => {
  let tmp;
  let mod;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'f231-pdir-'));
    mod = await import('../dist/domains/cats/services/profile/profile-dir.js');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('resolves a user beneath the explicit data root', () => {
    assert.equal(mod.resolveProfileDir('alice', tmp), resolve(tmp, 'profiles', 'alice'));
  });

  it('uses the same canonical root for reads and writes', () => {
    assert.equal(mod.resolveWritableProfileDir('alice', tmp), mod.resolveProfileDir('alice', tmp));
  });

  it('defaults the user id without treating a path as cwd', () => {
    assert.equal(mod.resolveProfileDir(undefined, tmp), resolve(tmp, 'profiles', 'default-user'));
  });

  it('encodes traversal-like external user ids into one safe segment', () => {
    assert.equal(mod.resolveProfileDir('../escape', tmp), resolve(tmp, 'profiles', '..%2Fescape'));
  });
});
