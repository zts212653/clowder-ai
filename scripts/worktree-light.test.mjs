import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { materializeAssets } from './lib/worktree-light.mjs';
import { createWorktree } from './worktree-new.mjs';

function mediaFixture(t) {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const name = 'docs/evidence/old/image.png';
  mkdirSync(join(f.repo, 'docs/evidence/old'), { recursive: true });
  writeFileSync(join(f.repo, name), Buffer.alloc(1024 * 1024, 7));
  git(f.repo, 'add', '-f', name);
  git(f.repo, 'commit', '-qm', 'large media');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { ...f, name };
}

test('new worktrees omit historical media before checkout but keep code, metadata and consumed assets', () => {
  const f = fixture();
  try {
    for (const dir of ['docs/evidence/old', 'docs/videos/demo', 'assets', 'packages/api/src'])
      mkdirSync(join(f.repo, dir), { recursive: true });
    const large = Buffer.alloc(1024 * 1024, 7);
    writeFileSync(join(f.repo, 'docs/evidence/old/recording.mp4'), large);
    writeFileSync(join(f.repo, 'docs/evidence/old/raw.tar.gz'), large);
    writeFileSync(join(f.repo, 'docs/evidence/old/paper.pdf'), large);
    writeFileSync(join(f.repo, 'docs/evidence/old/readme.md'), 'retain context');
    writeFileSync(join(f.repo, 'docs/evidence/old/index.json'), '{"ok":true}');
    writeFileSync(join(f.repo, 'docs/videos/demo/required.png'), large);
    writeFileSync(join(f.repo, 'assets/character.png'), large);
    writeFileSync(join(f.repo, 'packages/api/src/image.ts'), "export const image = 'docs/videos/demo/required.png';\n");
    git(f.repo, 'add', '-f', '.');
    git(f.repo, 'commit', '-qm', 'assets');
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const path = f.make();
    assert.equal(existsSync(join(path, 'docs/evidence/old/recording.mp4')), false, 'historical media deferred');
    assert.equal(
      existsSync(join(path, 'docs/evidence/old/raw.tar.gz')),
      false,
      'historical compressed evidence deferred',
    );
    assert.equal(existsSync(join(path, 'docs/evidence/old/paper.pdf')), false, 'historical PDF deferred');
    for (const name of [
      'docs/evidence/old/readme.md',
      'docs/evidence/old/index.json',
      'docs/videos/demo/required.png',
      'assets/character.png',
    ])
      assert.equal(existsSync(join(path, name)), true, name);
    assert.equal(git(path, 'status', '--porcelain'), '');
    assert.equal(
      git(f.repo, 'config', '--local', '--default', 'false', '--get', 'core.sparseCheckout').trim(),
      'false',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('materialize takes this branch version, preserves WIP and does not change main', (t) => {
  const f = mediaFixture(t);
  const path = f.make();
  writeFileSync(join(f.repo, f.name), 'new main version');
  git(f.repo, 'add', f.name);
  git(f.repo, 'commit', '-qm', 'new main media');
  writeFileSync(join(path, 'README.md'), 'WIP');
  writeFileSync(join(path, '.env.local'), 'PRIVATE=value');
  materializeAssets(path, ['docs/evidence/old']);
  assert.equal(readFileSync(join(path, f.name)).length, 1024 * 1024);
  assert.equal(readFileSync(join(f.repo, f.name), 'utf8'), 'new main version');
  assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'WIP');
  assert.equal(readFileSync(join(path, '.env.local'), 'utf8'), 'PRIVATE=value');
  assert.throws(() => materializeAssets(path, ['../cat-cafe']), /relative/);
  assert.throws(() => materializeAssets(path, ['docs/missing.png']), /no tracked/);
});

test('full creation and full hydration provide all files without modifying shared config', (t) => {
  const f = mediaFixture(t);
  const full = join(f.root, 'cat-cafe-full');
  createWorktree({ repo: f.repo, path: full, branch: 'full', owner: 'codex61-sol', full: true });
  assert.equal(existsSync(join(full, f.name)), true);
  const light = f.make();
  materializeAssets(light, [], { all: true });
  assert.equal(existsSync(join(light, f.name)), true);
  assert.equal(git(light, 'status', '--porcelain'), '');
  assert.equal(git(f.repo, 'config', '--local', '--default', 'false', '--get', 'core.sparseCheckout').trim(), 'false');
});

test('light finish and restore preserve originals and do not expand the historical archive', (t) => {
  const f = mediaFixture(t);
  const path = f.make();
  writeFileSync(join(path, '.env.local'), 'PRIVATE=value');
  const receipt = f.finish(path);
  assert.equal(existsSync(path), false);
  execFileSync('/bin/sh', ['-c', receipt.restore], { stdio: 'pipe' });
  assert.equal(existsSync(join(path, f.name)), false);
  assert.equal(readFileSync(join(path, '.env.local'), 'utf8'), 'PRIVATE=value');
  assert.equal(git(path, 'status', '--porcelain'), '');
  materializeAssets(path, [f.name]);
  assert.equal(readFileSync(join(path, f.name)).length, 1024 * 1024);
});

test('managed sparse checkout does not disguise manually hidden source changes', (t) => {
  const f = mediaFixture(t);
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    const path = f.make(`cat-cafe-${flag.slice(2)}`);
    git(path, 'update-index', flag, 'README.md');
    writeFileSync(join(path, 'README.md'), 'hidden original');
    assert.throws(() => f.finish(path), /hidden index|dirty worktree/);
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'hidden original');
  }
});
