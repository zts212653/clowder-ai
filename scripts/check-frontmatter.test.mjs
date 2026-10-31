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

function runDelta(root) {
  return spawnSync(process.execPath, [SCRIPT, '--docs-root', join(root, 'docs'), '--strict-delta', '--base', 'HEAD'], {
    cwd: root,
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
});
