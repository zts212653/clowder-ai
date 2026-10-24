import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { git, runHook, setupRepo } from './pre-commit-test-helpers.mjs';

const roots = [];
const fake = () => ['ghp', '_', 'C'.repeat(36)].join('');
const zero = '0'.repeat(40);
const hook = resolve('.githooks/pre-push');
const commitHook = resolve('.githooks/commit-msg');
function repo() {
  const root = setupRepo();
  roots.push(root);
  return root;
}
function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function push(root, newOid, oldOid = zero, ref = 'refs/heads/fixture-feature') {
  return spawnSync('bash', [hook, 'origin', join(root, 'remote.git')], {
    cwd: root,
    input: `refs/heads/fixture-feature ${newOid} ${ref} ${oldOid}\n`,
    encoding: 'utf8',
  });
}
function remote(root) {
  git(root, 'init', '--bare', join(root, 'remote.git'));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Git secret guards at real hook entry points', () => {
  it('rejects a secret in INDEX even when the worktree version was cleaned', () => {
    const root = repo();
    const path = 'docs/a file with spaces.md';
    write(root, path, `\`\`\`\n${fake()}\n\`\`\`\n`);
    git(root, 'add', path);
    write(root, path, 'clean in worktree\n');
    const result = runHook(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret_content_detected/);
    assert.ok(!result.stderr.includes(fake()));
  });

  it('allows clean INDEX with an unrelated secret only in unstaged work', () => {
    const root = repo();
    write(root, 'docs/guide.md', 'safe content\n');
    git(root, 'add', 'docs/guide.md');
    write(root, 'docs/guide.md', fake());
    assert.equal(runHook(root).status, 0);
  });

  it('checks a commit message without printing it', () => {
    const root = repo();
    const path = join(root, '.git', 'fixture-msg');
    writeFileSync(path, `explain ${fake()}\n`);
    const result = spawnSync('bash', [commitHook, path], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret_content_detected/);
    assert.ok(!result.stderr.includes(fake()));
    writeFileSync(path, 'safe message\n');
    assert.equal(spawnSync('bash', [commitHook, path], { cwd: root }).status, 0);
  });

  it('refuses an intermediate secret commit even after HEAD deletes the file', () => {
    const root = repo();
    remote(root);
    const base = git(root, 'rev-parse', 'HEAD').stdout.trim();
    write(root, 'docs/note.md', fake());
    git(root, 'add', 'docs/note.md');
    git(root, 'commit', '-qm', 'intermediate');
    git(root, 'rm', '-q', 'docs/note.md');
    git(root, 'commit', '-qm', 'remove');
    const result = push(root, git(root, 'rev-parse', 'HEAD').stdout.trim(), base);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret_content_detected/);
    assert.ok(!result.stderr.includes(fake()));
  });

  it('checks annotated tag messages before the existing early tag skip', () => {
    const root = repo();
    remote(root);
    const path = join(root, '.git', 'tag-message');
    writeFileSync(path, fake());
    git(root, 'tag', '-a', 'v-test', '-F', path);
    const result = push(root, git(root, 'rev-parse', 'v-test').stdout.trim(), zero, 'refs/tags/v-test');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret_content_detected/);
    assert.ok(!result.stderr.includes(fake()));
  });

  it('rejects unknown old remote objects instead of guessing a smaller range', () => {
    const root = repo();
    remote(root);
    const result = push(root, git(root, 'rev-parse', 'HEAD').stdout.trim(), 'f'.repeat(40));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret_scan_unavailable/);
  });

  it('can push an ordinary clean tag using only a local bare remote', () => {
    const root = repo();
    remote(root);
    git(root, 'tag', '-a', 'v-test', '-m', 'clean tag');
    const result = push(root, git(root, 'rev-parse', 'v-test').stdout.trim(), zero, 'refs/tags/v-test');
    assert.equal(result.status, 0);
  });
});
