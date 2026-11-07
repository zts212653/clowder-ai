import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const SCRIPT = resolve(process.cwd(), 'scripts/check-frontmatter.mjs');
const roots = [];

function makeRepo({ path = 'docs/notes/existing.md', content }) {
  const root = mkdtempSync(join(tmpdir(), 'cc-frontmatter-delta-'));
  roots.push(root);
  mkdirSync(join(root, 'docs', 'notes'), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'pipe' });
  return root;
}

function runDelta(root, { docsRoot = join(root, 'docs'), base = 'HEAD', cwd = root } = {}) {
  return spawnSync(process.execPath, [SCRIPT, '--docs-root', docsRoot, '--strict-delta', '--base', base], {
    cwd,
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-frontmatter --strict-delta', () => {
  it('fails closed when --base has no value', () => {
    const root = makeRepo({
      content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n',
    });
    const result = spawnSync(process.execPath, [SCRIPT, '--strict-delta', '--base'], {
      cwd: root,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--base requires a value/);
  });

  it('passes a normal edit to an existing valid document', () => {
    const root = makeRepo({
      content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n',
    });
    writeFileSync(
      join(root, 'docs/notes/existing.md'),
      `${readFileSync(join(root, 'docs/notes/existing.md'), 'utf8')}\nBody update.\n`,
      'utf8',
    );

    const result = runDelta(root);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /PASS check-frontmatter-delta/);
  });

  it('allows an unrelated edit to a legacy document that already lacked frontmatter', () => {
    const root = makeRepo({ content: '# Legacy\n' });
    writeFileSync(join(root, 'docs/notes/existing.md'), '# Legacy\n\nBody update.\n', 'utf8');

    const result = runDelta(root);

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  it('rejects a new document without required frontmatter', () => {
    const root = makeRepo({
      content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n',
    });
    writeFileSync(join(root, 'docs/notes/new.md'), '# New without metadata\n', 'utf8');

    const result = runDelta(root);

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /new\.md.*missing frontmatter/i);
  });

  it('rejects malformed frontmatter in an edited document', () => {
    const root = makeRepo({
      content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n',
    });
    writeFileSync(
      join(root, 'docs/notes/existing.md'),
      '---\ndoc_kind: note\ncreated: 2026-07-27\n\n# Missing closing delimiter\n',
      'utf8',
    );

    const result = runDelta(root);

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /existing\.md.*malformed frontmatter/i);
  });

  it('rejects removing a required field from existing frontmatter', () => {
    const root = makeRepo({
      content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n',
    });
    writeFileSync(join(root, 'docs/notes/existing.md'), '---\ndoc_kind: note\n---\n\n# Existing\n', 'utf8');

    const result = runDelta(root);

    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /existing\.md.*removed required field.*created/i);
  });

  it('ignores unrelated untracked output larger than the Git subprocess buffer', () => {
    const content = '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n';
    const root = makeRepo({ content });
    // Long paths exceed the default 1 MiB buffer with only 1,700 empty files.
    const cache = join(root, '.pnpm-store', ...Array.from({ length: 3 }, (_, i) => `${i}${'x'.repeat(150)}`));
    mkdirSync(cache, { recursive: true });
    for (let i = 0; i < 1700; i++) writeFileSync(join(cache, `${i}-${'x'.repeat(195)}.json`), '');
    writeFileSync(join(root, 'docs/notes/new.md'), content);
    writeFileSync(join(root, 'docs/unrelated.md'), '# Outside the selected directory\n');

    const result = runDelta(root, { docsRoot: join(root, 'docs/notes') });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /changed=1\b/);
  });

  it('checks committed, unstaged, staged and untracked documents with quoted filenames', () => {
    const content = '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n';
    const root = makeRepo({ content });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    writeFileSync(join(root, 'docs/notes/deleted.md'), content);
    git('add', '.');
    git('commit', '-m', 'add deletion fixture');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'docs/notes/已提交.md'), '# Missing metadata\n');
    git('add', 'docs/notes/已提交.md');
    git('commit', '-m', 'add committed document');
    writeFileSync(join(root, 'docs/notes/staged file.md'), '# Missing metadata\n');
    git('add', 'docs/notes/staged file.md');
    writeFileSync(join(root, 'docs/notes/existing.md'), '---\ndoc_kind: note\n---\n\n# Existing\n');
    writeFileSync(join(root, 'docs/notes/新 文档.md'), '# Missing metadata\n');
    rmSync(join(root, 'docs/notes/deleted.md'));
    mkdirSync(join(root, 'docs/notes-sibling'));
    writeFileSync(join(root, 'docs/notes-sibling/invalid.md'), '# Outside scope\n');
    writeFileSync(join(root, 'docs/notes/not-markdown.txt'), '# Not markdown\n');
    const docsRoot = join(root, 'docs/notes');

    const result = runDelta(root, { docsRoot, base });

    assert.equal(result.status, 1, result.stderr);
    for (const name of ['已提交.md', 'staged file.md', '新 文档.md']) {
      assert.ok(result.stderr.includes(`${name}: missing frontmatter`), result.stderr);
    }
    assert.match(result.stderr, /existing\.md: removed required field created/);
    assert.doesNotMatch(result.stderr, /deleted\.md|invalid\.md|not-markdown/);

    for (const name of ['已提交.md', 'staged file.md', '新 文档.md', 'existing.md']) {
      writeFileSync(join(docsRoot, name), `${content}\nUpdated body.\n`);
    }
    const valid = runDelta(root, { docsRoot, base });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /changed=4\b/);
  });

  it('resolves relative docs roots from a subdirectory without losing changed files', () => {
    const root = makeRepo({ content: '---\ndoc_kind: note\ncreated: 2026-07-27\n---\n\n# Existing\n' });
    writeFileSync(join(root, 'docs/notes/existing.md'), '---\ndoc_kind: note\n---\n\n# Existing\n');

    const result = runDelta(root, { cwd: join(root, 'docs'), docsRoot: 'notes' });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /existing\.md: removed required field created/);
  });

  it('uses the selected docs worktree when invoked from a different checkout', () => {
    const root = makeRepo({ content: '# Legacy\n' });
    const checkout = join(root, 'feature-checkout');
    execFileSync('git', ['worktree', 'add', '--detach', checkout, 'HEAD'], { cwd: root, stdio: 'pipe' });
    writeFileSync(join(root, 'docs/notes/new.md'), '# Missing metadata\n');

    const result = runDelta(root, { cwd: checkout });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /new\.md: missing frontmatter/);
  });

  it('rejects a docs root outside a Git worktree instead of reporting an empty success', () => {
    const root = makeRepo({ content: '# Legacy\n' });
    const outside = mkdtempSync(join(tmpdir(), 'cc-frontmatter-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'invalid.md'), '# Missing metadata\n');

    const result = runDelta(root, { docsRoot: outside });

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /not a git repository|must be inside a Git worktree/i);
    assert.doesNotMatch(result.stdout, /PASS/);
  });

  it('treats pathspec metacharacters in the selected directory literally', () => {
    const root = makeRepo({ content: '# Legacy\n' });
    const docsRoot = join(root, 'docs/文档 [1]');
    mkdirSync(docsRoot);
    writeFileSync(join(docsRoot, 'new.md'), '# Missing metadata\n');

    const result = runDelta(root, { docsRoot });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /new\.md: missing frontmatter/);
  });

  it('accepts the Git worktree root as the selected directory', () => {
    const root = makeRepo({ content: '# Legacy\n' });
    writeFileSync(join(root, 'new.md'), '# Missing metadata\n');

    const result = runDelta(root, { docsRoot: root });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /new\.md: missing frontmatter/);
  });
});
