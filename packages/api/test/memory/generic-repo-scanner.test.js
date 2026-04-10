import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('GenericRepoScanner', () => {
  let tmpDir;
  let scanner;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f152-generic-${randomUUID().slice(0, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
    const { GenericRepoScanner } = await import('../../dist/domains/memory/GenericRepoScanner.js');
    scanner = new GenericRepoScanner();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Authoritative tier ──────────────────────────────────────────

  it('scans README.md as authoritative', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# My Project\n\nA cool project.');
    const results = scanner.discover(tmpDir);
    const readme = results.find((r) => r.item.sourcePath === 'README.md');
    assert.ok(readme, 'should find README');
    assert.equal(readme.provenance.tier, 'authoritative');
    assert.equal(readme.item.kind, 'plan');
    assert.ok(readme.rawContent.includes('cool project'));
  });

  it('scans ARCHITECTURE.md as authoritative', () => {
    writeFileSync(join(tmpDir, 'ARCHITECTURE.md'), '# Architecture\n\nSystem overview.');
    const results = scanner.discover(tmpDir);
    const arch = results.find((r) => r.provenance.source === 'ARCHITECTURE.md');
    assert.ok(arch);
    assert.equal(arch.provenance.tier, 'authoritative');
  });

  it('scans CONTRIBUTING.md as authoritative', () => {
    writeFileSync(join(tmpDir, 'CONTRIBUTING.md'), '# Contributing\n\nHow to contribute.');
    const results = scanner.discover(tmpDir);
    const contrib = results.find((r) => r.provenance.source === 'CONTRIBUTING.md');
    assert.ok(contrib);
    assert.equal(contrib.provenance.tier, 'authoritative');
  });

  it('scans docs/**/*.md as authoritative', () => {
    mkdirSync(join(tmpDir, 'docs', 'api'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'guide.md'), '# Guide\n\nHow to use.');
    writeFileSync(join(tmpDir, 'docs', 'api', 'endpoints.md'), '# Endpoints\n\nAPI docs.');
    const results = scanner.discover(tmpDir);
    const guide = results.find((r) => r.item.sourcePath === 'docs/guide.md');
    assert.ok(guide, 'should find docs/guide.md');
    assert.equal(guide.provenance.tier, 'authoritative');
    const endpoints = results.find((r) => r.item.sourcePath === 'docs/api/endpoints.md');
    assert.ok(endpoints, 'should find nested docs/api/endpoints.md');
    assert.equal(endpoints.provenance.tier, 'authoritative');
  });

  it('scans ADR files as authoritative', () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'ADR-001-use-postgres.md'), '# ADR-001\n\nUse PostgreSQL.');
    const results = scanner.discover(tmpDir);
    const adr = results.find((r) => r.item.sourcePath === 'docs/ADR-001-use-postgres.md');
    assert.ok(adr);
    assert.equal(adr.provenance.tier, 'authoritative');
  });

  // ── Derived tier ────────────────────────────────────────────────

  it('scans package.json as derived', () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        description: 'A test project',
        dependencies: { express: '^4.18' },
      }),
    );
    const results = scanner.discover(tmpDir);
    const pkg = results.find((r) => r.provenance.source === 'package.json');
    assert.ok(pkg, 'should find package.json');
    assert.equal(pkg.provenance.tier, 'derived');
    assert.equal(pkg.item.kind, 'research');
    assert.ok(pkg.item.title.includes('test-project'));
  });

  it('scans Cargo.toml as derived', () => {
    writeFileSync(
      join(tmpDir, 'Cargo.toml'),
      '[package]\nname = "my-crate"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\n',
    );
    const results = scanner.discover(tmpDir);
    const cargo = results.find((r) => r.provenance.source === 'Cargo.toml');
    assert.ok(cargo);
    assert.equal(cargo.provenance.tier, 'derived');
  });

  it('scans pyproject.toml as derived', () => {
    writeFileSync(join(tmpDir, 'pyproject.toml'), '[project]\nname = "my-app"\nversion = "1.0"\n');
    const results = scanner.discover(tmpDir);
    const py = results.find((r) => r.provenance.source === 'pyproject.toml');
    assert.ok(py);
    assert.equal(py.provenance.tier, 'derived');
  });

  it('scans go.mod as derived', () => {
    writeFileSync(join(tmpDir, 'go.mod'), 'module github.com/user/repo\n\ngo 1.21\n');
    const results = scanner.discover(tmpDir);
    const gomod = results.find((r) => r.provenance.source === 'go.mod');
    assert.ok(gomod);
    assert.equal(gomod.provenance.tier, 'derived');
  });

  // ── Soft-clue tier ──────────────────────────────────────────────

  it('scans CHANGELOG.md as soft_clue', () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0\n- Initial release');
    const results = scanner.discover(tmpDir);
    const cl = results.find((r) => r.provenance.source === 'CHANGELOG.md');
    assert.ok(cl, 'should find CHANGELOG');
    assert.equal(cl.provenance.tier, 'soft_clue');
    assert.equal(cl.item.kind, 'lesson');
  });

  it('scans .github/ISSUE_TEMPLATE as soft_clue', () => {
    mkdirSync(join(tmpDir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'),
      '---\nname: Bug Report\n---\n\n## Describe the bug\n',
    );
    const results = scanner.discover(tmpDir);
    const tmpl = results.find((r) => r.provenance.source.includes('ISSUE_TEMPLATE'));
    assert.ok(tmpl, 'should find issue template');
    assert.equal(tmpl.provenance.tier, 'soft_clue');
  });

  // ── Exclusions ──────────────────────────────────────────────────

  it('does not scan node_modules or .git', () => {
    mkdirSync(join(tmpDir, 'node_modules', 'foo'), { recursive: true });
    mkdirSync(join(tmpDir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'foo', 'README.md'), '# Foo');
    writeFileSync(join(tmpDir, '.git', 'objects', 'readme.md'), 'git data');
    writeFileSync(join(tmpDir, 'README.md'), '# Root');
    const results = scanner.discover(tmpDir);
    assert.equal(results.length, 1, 'should only find root README');
  });

  // ── KD-7: repo-relative sourcePath ──────────────────────────────

  it('sourcePath is repo-relative (KD-7)', () => {
    mkdirSync(join(tmpDir, 'docs', 'api'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'api', 'endpoints.md'), '# Endpoints');
    const results = scanner.discover(tmpDir);
    const ep = results.find((r) => r.item.sourcePath === 'docs/api/endpoints.md');
    assert.ok(ep, 'sourcePath should be repo-relative');
  });

  // ── skipSoftClues option (AC-A5) ────────────────────────────────

  it('skipSoftClues excludes soft_clue tier', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Big Repo');
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog');
    const results = scanner.discover(tmpDir, { skipSoftClues: true });
    assert.ok(results.some((r) => r.provenance.tier === 'authoritative'));
    assert.ok(!results.some((r) => r.provenance.tier === 'soft_clue'));
  });

  // ── Frontmatter-aware ───────────────────────────────────────────

  it('extracts anchor from docs with YAML frontmatter', () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'docs', 'design.md'),
      '---\nfeature_ids: [FEAT-42]\ntopics: [design]\n---\n\n# Design Doc\n\nSome design.\n',
    );
    const results = scanner.discover(tmpDir);
    const design = results.find((r) => r.item.anchor === 'FEAT-42');
    assert.ok(design, 'should extract anchor from frontmatter');
  });

  // ── parseSingle tier consistency ───────────────────────────────

  it('parseSingle classifies .github/ISSUE_TEMPLATE as soft_clue (P1-6 fix)', () => {
    mkdirSync(join(tmpDir, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
    const tmplPath = join(tmpDir, '.github', 'ISSUE_TEMPLATE', 'bug_report.md');
    writeFileSync(tmplPath, '---\nname: Bug Report\n---\n\n## Describe the bug\n');
    const result = scanner.parseSingle(tmplPath, tmpDir);
    assert.ok(result, 'should parse issue template');
    assert.equal(result.provenance.tier, 'soft_clue', 'ISSUE_TEMPLATE must be soft_clue');
    assert.equal(result.item.kind, 'lesson', 'ISSUE_TEMPLATE must be lesson kind');
  });

  it('parseSingle classifies top-level CHANGELOG as soft_clue', () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## v1.0\nRelease.');
    const result = scanner.parseSingle(join(tmpDir, 'CHANGELOG.md'), tmpDir);
    assert.ok(result, 'should parse changelog');
    assert.equal(result.provenance.tier, 'soft_clue');
    assert.equal(result.item.kind, 'lesson');
  });

  it('parseSingle classifies docs/** as authoritative', () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(join(tmpDir, 'docs', 'guide.md'), '# Guide\n\nContent.');
    const result = scanner.parseSingle(join(tmpDir, 'docs', 'guide.md'), tmpDir);
    assert.ok(result, 'should parse docs file');
    assert.equal(result.provenance.tier, 'authoritative');
  });
});
