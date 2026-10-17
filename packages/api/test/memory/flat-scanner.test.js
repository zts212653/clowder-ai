// F186 Phase B Task 1: FlatScanner — Level 0 scanner for arbitrary markdown
// AC-B1: indexes any markdown directory without frontmatter requirement

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, win32 } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('FlatScanner', () => {
  let FlatScanner;
  let tmpDir;

  beforeEach(async () => {
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    tmpDir = mkdtempSync(join(tmpdir(), 'flat-scan-'));
  });

  it('discovers .md files recursively without frontmatter', () => {
    writeFileSync(join(tmpDir, 'intro.md'), '# Introduction\n\nThis is a plain document.');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'nested.md'), '# Nested\n\nNested content.');

    const scanner = new FlatScanner('test:docs');
    const results = scanner.discover(tmpDir);

    assert.equal(results.length, 2);
    const anchors = results.map((r) => r.item.anchor).sort();
    assert.ok(anchors.includes('test:docs:doc/intro'));
    assert.ok(anchors.includes('test:docs:doc/sub/nested'));
  });

  it('extracts title from first heading', () => {
    writeFileSync(join(tmpDir, 'titled.md'), '# My Great Document\n\nSome content.');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.title, 'My Great Document');
  });

  it('falls back to filename when no heading', () => {
    writeFileSync(join(tmpDir, 'no-heading.md'), 'Just raw text without any heading.');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.title, 'no-heading');
  });

  it('extracts summary from first paragraph', () => {
    writeFileSync(join(tmpDir, 'summary.md'), '# Title\n\nThis is the summary paragraph.\n\n## Section');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.summary, 'This is the summary paragraph.');
  });

  it('sets provenance tier to derived', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc\n\nContent.');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.provenance.tier, 'derived');
  });

  it('sets kind to research for all items', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc\n\nContent.');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.kind, 'research');
  });

  it('respects exclude patterns', () => {
    writeFileSync(join(tmpDir, 'keep.md'), '# Keep');
    mkdirSync(join(tmpDir, 'drafts'));
    writeFileSync(join(tmpDir, 'drafts', 'skip.md'), '# Skip');
    const scanner = new FlatScanner('test:docs', ['drafts/**']);
    const results = scanner.discover(tmpDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].item.anchor, 'test:docs:doc/keep');
  });

  it('skips non-.md files', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc');
    writeFileSync(join(tmpDir, 'image.png'), 'binary');
    writeFileSync(join(tmpDir, 'data.json'), '{}');
    const scanner = new FlatScanner('test:docs');
    assert.equal(scanner.discover(tmpDir).length, 1);
  });

  it('skips .git and node_modules directories', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc');
    mkdirSync(join(tmpDir, '.git'));
    writeFileSync(join(tmpDir, '.git', 'HEAD.md'), '# git');
    mkdirSync(join(tmpDir, 'node_modules'));
    writeFileSync(join(tmpDir, 'node_modules', 'pkg.md'), '# pkg');
    const scanner = new FlatScanner('test:docs');
    assert.equal(scanner.discover(tmpDir).length, 1);
  });

  // Upstream review on #1451: the skip must be bound to a real Git boundary, not to a directory
  // name — a plain `worktrees/` directory holds ordinary documents and must still be indexed.
  it('indexes a plain worktrees/ directory that has no Git marker (review fix)', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc');
    mkdirSync(join(tmpDir, 'worktrees'));
    writeFileSync(join(tmpDir, 'worktrees', 'guide.md'), '# Guide');

    const results = new FlatScanner('test:docs').discover(tmpDir);

    assert.equal(results.length, 2, 'a plain worktrees/ dir must not be silently dropped');
    assert.ok(
      results.some((r) => r.item.anchor === 'test:docs:doc/worktrees/guide'),
      `expected the worktrees/guide anchor, got: ${results.map((r) => r.item.anchor).join(', ')}`,
    );
  });

  // Matrix requested by the review: plain worktrees dir indexed / real worktree skipped from the
  // parent root / the same worktree still indexed when bound directly.
  it('matrix: real worktree root is skipped from the parent but indexed when bound directly', () => {
    writeFileSync(join(tmpDir, 'root.md'), '# Root');
    mkdirSync(join(tmpDir, 'worktrees', 'wt', 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'worktrees', 'wt', '.git'), 'gitdir: ../../.git/worktrees/wt');
    writeFileSync(join(tmpDir, 'worktrees', 'wt', 'docs', 'inner.md'), '# Inner');

    const scanner = new FlatScanner('test:docs');
    assert.deepEqual(
      scanner.discover(tmpDir).map((r) => r.item.sourcePath),
      ['root.md'],
      'the real worktree must not leak into the parent collection',
    );
    assert.deepEqual(
      scanner.discover(join(tmpDir, 'worktrees', 'wt')).map((r) => r.item.sourcePath),
      ['docs/inner.md'],
      'the same worktree must still be indexable when it is the collection root',
    );
  });

  it('does not descend into nested git repositories', () => {
    writeFileSync(join(tmpDir, 'doc.md'), '# Doc');

    // Nested repo: .git is a directory
    mkdirSync(join(tmpDir, 'nested', '.git'), { recursive: true });
    writeFileSync(join(tmpDir, 'nested', 'inner.md'), '# Inner');

    // Nested worktree: .git is a file pointing at the parent repo
    mkdirSync(join(tmpDir, 'linked', 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'linked', '.git'), 'gitdir: ../.git/worktrees/linked');
    writeFileSync(join(tmpDir, 'linked', 'docs', 'inner.md'), '# Inner');

    const scanner = new FlatScanner('test:docs');
    const results = scanner.discover(tmpDir);

    assert.equal(results.length, 1, 'only the root document should be discovered');
    assert.equal(results[0].item.anchor, 'test:docs:doc/doc');
  });

  // Review on #1451 (round 2): an existence check on the `.git` name treated any stray file as a
  // repository boundary and dropped the whole subtree.
  it('keeps indexing a subtree whose `.git` file is not a worktree marker (review counter-example)', () => {
    writeFileSync(join(tmpDir, 'root.md'), '# Root');
    mkdirSync(join(tmpDir, 'nested', 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'nested', '.git'), 'ordinary text');
    writeFileSync(join(tmpDir, 'nested', 'docs', 'guide.md'), '# Guide');

    const results = new FlatScanner('test:docs').discover(tmpDir);

    assert.deepEqual(
      results.map((r) => r.item.sourcePath).sort(),
      ['nested/docs/guide.md', 'root.md'],
      'a stray .git file must not drop the subtree',
    );
  });

  it('skips a subtree whose `.git` file carries a gitdir marker (boundary control)', () => {
    writeFileSync(join(tmpDir, 'root.md'), '# Root');
    mkdirSync(join(tmpDir, 'nested', 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'nested', '.git'), 'gitdir: ../../.git/worktrees/nested\n');
    writeFileSync(join(tmpDir, 'nested', 'docs', 'guide.md'), '# Guide');

    assert.deepEqual(
      new FlatScanner('test:docs').discover(tmpDir).map((r) => r.item.sourcePath),
      ['root.md'],
    );
  });

  // win32 contract: `path.relative` yields `\` on Windows, which used to defeat `exclude` matching
  // and leak the separator into anchors (`doc/private\secret`) — cross-platform drift.
  it('normalizes win32 relative paths before exclude matching and anchoring', async () => {
    const { matchGlob } = await import('../../dist/domains/memory/FlatScanner.js');
    const { toPosixPath } = await import('../../dist/domains/memory/path-utils.js');
    const rel = win32.relative('C:\\project', 'C:\\project\\private\\secret.md');

    assert.equal(rel, 'private\\secret.md', 'precondition: win32.relative emits backslashes');
    assert.equal(matchGlob('private/**', rel), false, 'the raw win32 path escapes the exclude glob');
    if (sep === '\\') {
      assert.equal(toPosixPath(rel), 'private/secret.md');
      assert.equal(matchGlob('private/**', toPosixPath(rel)), true, 'normalized path must match');
    } else {
      // On POSIX a literal backslash is a filename character, so the helper must not rewrite it.
      assert.equal(toPosixPath(rel), rel);
    }
  });

  it('respects depth limit of 10', () => {
    let dir = tmpDir;
    for (let i = 0; i < 12; i++) {
      dir = join(dir, `d${i}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, 'deep.md'), '# Deep');
    const scanner = new FlatScanner('test:docs');
    assert.equal(scanner.discover(tmpDir).length, 0);
  });

  it('extracts section headings as keywords', () => {
    writeFileSync(join(tmpDir, 'kw.md'), '# Title\n\n## Architecture\n\n## Design\n\nContent.');
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.deepEqual(result.item.keywords, ['Architecture', 'Design']);
  });

  it('parseSingle returns single file evidence', () => {
    const file = join(tmpDir, 'single.md');
    writeFileSync(file, '# Single\n\nParsed individually.');
    const scanner = new FlatScanner('test:docs');
    const result = scanner.parseSingle(file, tmpDir);
    assert.ok(result);
    assert.equal(result.item.anchor, 'test:docs:doc/single');
  });

  it('returns rawContent with full file text', () => {
    const content = '# Full Content\n\nParagraph one.\n\n## Section\n\nParagraph two.';
    writeFileSync(join(tmpDir, 'full.md'), content);
    const scanner = new FlatScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.rawContent, content);
  });

  it('handles empty directory gracefully', () => {
    const scanner = new FlatScanner('test:docs');
    const results = scanner.discover(tmpDir);
    assert.equal(results.length, 0);
  });

  it('exclude **/*.md matches root-level files (P1-2)', () => {
    writeFileSync(join(tmpDir, 'root.md'), '# Root');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'nested.md'), '# Nested');
    const scanner = new FlatScanner('test:docs', ['**/*.md']);
    const results = scanner.discover(tmpDir);
    assert.equal(results.length, 0, '**/*.md should exclude root-level files too');
  });

  it('P2-2: discovers markdown in src/ lib/ packages/ directories', () => {
    mkdirSync(join(tmpDir, 'src', 'docs'), { recursive: true });
    mkdirSync(join(tmpDir, 'lib'), { recursive: true });
    mkdirSync(join(tmpDir, 'packages', 'plugin'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'docs', 'api.md'), '# API Docs');
    writeFileSync(join(tmpDir, 'lib', 'README.md'), '# Lib README');
    writeFileSync(join(tmpDir, 'packages', 'plugin', 'README.md'), '# Plugin');
    const scanner = new FlatScanner('test:col');
    const results = scanner.discover(tmpDir);
    const paths = results.map((r) => r.item.sourcePath);
    assert.ok(
      paths.some((p) => p.includes('src')),
      `should discover docs in src/: ${paths}`,
    );
    assert.ok(
      paths.some((p) => p.includes('lib')),
      `should discover docs in lib/: ${paths}`,
    );
    assert.ok(
      paths.some((p) => p.includes('packages')),
      `should discover docs in packages/: ${paths}`,
    );
  });

  it('exclude docs/**/*.md matches files directly in docs/ (P1-2)', () => {
    mkdirSync(join(tmpDir, 'docs'));
    writeFileSync(join(tmpDir, 'docs', 'a.md'), '# A');
    mkdirSync(join(tmpDir, 'docs', 'sub'));
    writeFileSync(join(tmpDir, 'docs', 'sub', 'b.md'), '# B');
    writeFileSync(join(tmpDir, 'keep.md'), '# Keep');
    const scanner = new FlatScanner('test:docs', ['docs/**/*.md']);
    const results = scanner.discover(tmpDir);
    assert.equal(results.length, 1, 'only keep.md outside docs/ should remain');
    assert.equal(results[0].item.anchor, 'test:docs:doc/keep');
  });
});

// Shared path helpers (path-utils) — regression coverage requested by the upstream review on #1451.
// These live here rather than in a new `path-utils.test.js` because `config/public-test-exclusions.json`
// audits the exact `test/memory/` file inventory (count + hash): adding a file to this directory trips
// "audited match inventory drift" and fails the repo-wide public-test plan job.
describe('path-utils', () => {
  const load = async () => import('../../dist/domains/memory/path-utils.js');

  it('toPosixPath converts separators only where the platform uses them', async () => {
    const { toPosixPath } = await load();

    if (sep === '\\') {
      assert.equal(toPosixPath('foo\\bar.md'), 'foo/bar.md');
      assert.equal(toPosixPath('docs\\a\\b.md'), 'docs/a/b.md');
      assert.equal(toPosixPath('foo/bar.md'), 'foo/bar.md', 'already-POSIX input is unchanged');
    } else {
      assert.equal(toPosixPath('foo/bar.md'), 'foo/bar.md');
      // A literal backslash is a legal POSIX filename character: rewriting it collapsed `foo/bar.md`
      // and the distinct file `foo\bar.md` onto one canonical identity.
      assert.equal(toPosixPath('foo\\bar.md'), 'foo\\bar.md');
      assert.notEqual(toPosixPath('foo/bar.md'), toPosixPath('foo\\bar.md'), 'must not collide');
      // ...and a literal `..\name.md` filename must not turn into a traversal-looking path.
      assert.equal(toPosixPath('..\\name.md'), '..\\name.md');
    }
  });

  it('isPathInside follows native containment semantics', async () => {
    const { isPathInside } = await load();
    const dir = mkdtempSync(join(tmpdir(), 'path-utils-'));
    try {
      const root = resolve(dir, 'b');
      assert.equal(isPathInside(root, root), true, 'root contains itself');
      assert.equal(isPathInside(root, resolve(root, 'c')), true, 'direct child');
      assert.equal(isPathInside(root, resolve(root, 'c', 'd')), true, 'nested child');
      assert.equal(isPathInside(root, resolve(root, '..foo')), true, 'child literally named ..foo');
      assert.equal(isPathInside(root, resolve(dir, 'bc')), false, 'same-prefix sibling');
      assert.equal(isPathInside(root, resolve(dir, '..')), false, 'parent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isPathInside delegates win32 case/drive semantics to the platform', async () => {
    const { isPathInside } = await load();

    if (process.platform === 'win32') {
      // win32 paths are case-insensitive: the old string-prefix check missed this and skipped the
      // child exclude, re-indexing child documents into the parent collection.
      assert.equal(isPathInside('C:\\Project', 'c:\\project\\docs\\secret.md'), true);
      assert.equal(isPathInside('C:\\a', 'D:\\b'), false, 'different drive is not containment');
    } else {
      // POSIX is case-sensitive, so the same call must NOT be reported as containment.
      assert.equal(isPathInside('/tmp/Project', '/tmp/project/docs/secret.md'), false);
    }
  });
});
