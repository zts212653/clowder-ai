// F186 Phase B Task 1: FlatScanner — Level 0 scanner for arbitrary markdown
// AC-B1: indexes any markdown directory without frontmatter requirement

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
