// F186 Phase B Task 2: StructuredScanner — Level 1 scanner using existing structure
// AC-B2: leverages frontmatter, WikiLinks, SUMMARY.md when present

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('StructuredScanner', () => {
  let StructuredScanner;
  let tmpDir;

  beforeEach(async () => {
    ({ StructuredScanner } = await import('../../dist/domains/memory/StructuredScanner.js'));
    tmpDir = mkdtempSync(join(tmpdir(), 'struct-scan-'));
  });

  it('upgrades provenance to authoritative when frontmatter present', () => {
    writeFileSync(
      join(tmpDir, 'doc.md'),
      '---\ndoc_kind: decision\ntopics: [arch, memory]\n---\n# Decision\n\nWe decided X.',
    );
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.provenance.tier, 'authoritative');
  });

  it('extracts kind from frontmatter doc_kind', () => {
    writeFileSync(join(tmpDir, 'adr.md'), '---\ndoc_kind: decision\n---\n# ADR-001\n\nDecision content.');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.kind, 'decision');
  });

  it('extracts topics from frontmatter as keywords', () => {
    writeFileSync(
      join(tmpDir, 'topics.md'),
      '---\ntopics: [memory, search, federation]\n---\n# Topics Test\n\nContent.',
    );
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.ok(result.item.keywords?.includes('memory'));
    assert.ok(result.item.keywords?.includes('search'));
    assert.ok(result.item.keywords?.includes('federation'));
  });

  it('extracts anchor from frontmatter when present', () => {
    writeFileSync(join(tmpDir, 'anchored.md'), '---\nanchor: ADR-042\n---\n# ADR 42\n\nContent.');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.item.anchor, 'test:docs:ADR-042');
  });

  it('falls back to Level 0 for files without frontmatter', () => {
    writeFileSync(join(tmpDir, 'plain.md'), '# Plain\n\nNo frontmatter here.');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.equal(result.provenance.tier, 'derived');
    assert.equal(result.item.kind, 'research');
  });

  it('extracts WikiLink targets as keywords', () => {
    writeFileSync(join(tmpDir, 'linked.md'), '# Linked\n\nSee [[architecture]] and [[decisions/ADR-001]].');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.ok(result.item.keywords?.includes('architecture'));
    assert.ok(result.item.keywords?.includes('decisions/ADR-001'));
  });

  it('handles WikiLinks with display text', () => {
    writeFileSync(join(tmpDir, 'alias.md'), '# Alias\n\nSee [[real-target|display name]].');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    assert.ok(result.item.keywords?.includes('real-target'));
  });

  it('deduplicates WikiLink targets', () => {
    writeFileSync(join(tmpDir, 'dup.md'), '# Dup\n\nSee [[same-link]] and also [[same-link]] again.');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    const count = result.item.keywords?.filter((k) => k === 'same-link').length ?? 0;
    assert.equal(count, 1);
  });

  it('indexes SUMMARY.md as a regular file', () => {
    writeFileSync(join(tmpDir, 'SUMMARY.md'), '# Summary\n\n- [Intro](intro.md)\n- [Design](design.md)');
    writeFileSync(join(tmpDir, 'intro.md'), '# Intro\n\nIntro content.');
    writeFileSync(join(tmpDir, 'design.md'), '# Design\n\nDesign content.');
    const scanner = new StructuredScanner('test:docs');
    const results = scanner.discover(tmpDir);
    assert.ok(results.some((r) => r.item.sourcePath === 'SUMMARY.md'));
    assert.equal(results.length, 3);
  });

  it('mixed directory: structured + plain files coexist', () => {
    writeFileSync(join(tmpDir, 'structured.md'), '---\ndoc_kind: plan\ntopics: [api]\n---\n# Plan\n\nPlan content.');
    writeFileSync(join(tmpDir, 'plain.md'), '# Plain\n\nJust text.');
    const scanner = new StructuredScanner('test:docs');
    const results = scanner.discover(tmpDir);
    const structured = results.find((r) => r.item.sourcePath === 'structured.md');
    const plain = results.find((r) => r.item.sourcePath === 'plain.md');
    assert.equal(structured?.provenance.tier, 'authoritative');
    assert.equal(plain?.provenance.tier, 'derived');
  });

  it('maps common doc_kind values to evidence kinds', () => {
    const kinds = [
      ['spec', 'feature'],
      ['plan', 'plan'],
      ['lesson', 'lesson'],
      ['discussion', 'discussion'],
      ['research', 'research'],
      ['adr', 'decision'],
    ];
    for (const [docKind, expected] of kinds) {
      const dir = mkdtempSync(join(tmpdir(), 'kind-'));
      writeFileSync(join(dir, 'test.md'), `---\ndoc_kind: ${docKind}\n---\n# Test\n\nContent.`);
      const scanner = new StructuredScanner('test:kinds');
      const [result] = scanner.discover(dir);
      assert.equal(result.item.kind, expected, `doc_kind "${docKind}" should map to "${expected}"`);
    }
  });

  it('merges frontmatter topics with section keywords without duplication', () => {
    writeFileSync(join(tmpDir, 'merge.md'), '---\ntopics: [Architecture]\n---\n# Doc\n\n## Architecture\n\n## Design');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    const archCount = result.item.keywords?.filter((k) => k === 'Architecture').length ?? 0;
    assert.equal(archCount, 1, 'Architecture should appear once, not duplicated');
    assert.ok(result.item.keywords?.includes('Design'));
  });

  it('deduplicates keywords case-insensitively (P2)', () => {
    writeFileSync(
      join(tmpDir, 'case.md'),
      '---\ntopics: [Architecture]\n---\n# Doc\n\n## architecture\n\nSee [[ARCHITECTURE]].',
    );
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    const archVariants = result.item.keywords?.filter((k) => k.toLowerCase() === 'architecture') ?? [];
    assert.equal(archVariants.length, 1, 'case variants should be deduplicated to one entry');
  });

  it('deduplicates WikiLink internal case variants without frontmatter (P2-R2)', () => {
    writeFileSync(join(tmpDir, 'wiki.md'), '# Doc\n\nSee [[ARCH]] and [[arch]].');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    const archVariants = result.item.keywords?.filter((k) => k.toLowerCase() === 'arch') ?? [];
    assert.equal(archVariants.length, 1, 'WikiLink case variants should deduplicate without frontmatter');
  });

  it('deduplicates WikiLink internal case variants with frontmatter (P2-R2)', () => {
    writeFileSync(join(tmpDir, 'fmwiki.md'), '---\ndoc_kind: plan\n---\n# Doc\n\nSee [[ARCH]] and [[arch]].');
    const scanner = new StructuredScanner('test:docs');
    const [result] = scanner.discover(tmpDir);
    const archVariants = result.item.keywords?.filter((k) => k.toLowerCase() === 'arch') ?? [];
    assert.equal(archVariants.length, 1, 'WikiLink case variants should deduplicate with frontmatter');
  });
});
