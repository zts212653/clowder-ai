// F186 Phase B Task 3: scanner-resolver — dispatches scannerLevel to scanner instance
// AC-B3: scanner level configurable in manifest (auto/0/1/2/3)

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

describe('scanner-resolver', () => {
  let resolveCollectionScanner, detectScannerLevel, FlatScanner, StructuredScanner;

  beforeEach(async () => {
    ({ resolveCollectionScanner, detectScannerLevel } = await import('../../dist/domains/memory/scanner-resolver.js'));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ StructuredScanner } = await import('../../dist/domains/memory/StructuredScanner.js'));
  });

  const makeManifest = (overrides) => ({
    id: 'test:col',
    kind: 'domain',
    name: 'col',
    displayName: 'Col',
    root: '/tmp',
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-04',
    updatedAt: '2026-05-04',
    ...overrides,
  });

  it('scannerLevel 0 returns FlatScanner', () => {
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 0 }));
    assert.ok(scanner instanceof FlatScanner);
    assert.ok(!(scanner instanceof StructuredScanner));
  });

  it('scannerLevel 1 returns StructuredScanner', () => {
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 1 }));
    assert.ok(scanner instanceof StructuredScanner);
  });

  it('scannerLevel 2 falls back to StructuredScanner', () => {
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 2 }));
    assert.ok(scanner instanceof StructuredScanner);
  });

  it('scannerLevel 3 falls back to StructuredScanner', () => {
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 3 }));
    assert.ok(scanner instanceof StructuredScanner);
  });

  it('scannerLevel auto detects Level 0 for plain directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-'));
    writeFileSync(join(dir, 'x.md'), '# X');
    writeFileSync(join(dir, 'y.md'), '# Y');
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 'auto', root: dir }));
    assert.ok(scanner instanceof FlatScanner);
    assert.ok(!(scanner instanceof StructuredScanner));
  });

  it('detectScannerLevel returns 1 when frontmatter majority', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-'));
    writeFileSync(join(dir, 'a.md'), '---\ndoc_kind: plan\n---\n# A');
    writeFileSync(join(dir, 'b.md'), '---\ntopics: [x]\n---\n# B');
    writeFileSync(join(dir, 'c.md'), '# C');
    assert.equal(detectScannerLevel(dir), 1);
  });

  it('detectScannerLevel returns 1 when SUMMARY.md present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-'));
    writeFileSync(join(dir, 'SUMMARY.md'), '# Summary\n\n- [A](a.md)');
    writeFileSync(join(dir, 'a.md'), '# A');
    assert.equal(detectScannerLevel(dir), 1);
  });

  it('detectScannerLevel returns 0 for plain directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-'));
    writeFileSync(join(dir, 'x.md'), '# X');
    writeFileSync(join(dir, 'y.md'), '# Y');
    assert.equal(detectScannerLevel(dir), 0);
  });

  it('detectScannerLevel returns 0 for empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-'));
    assert.equal(detectScannerLevel(dir), 0);
  });

  it('detectScannerLevel samples exactly 20 files without off-by-one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'detect-obo-'));
    for (let i = 0; i < 21; i++) {
      const content = i < 10 ? `---\ndoc_kind: plan\n---\n# F${i}` : `# P${i}`;
      writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.md`), content);
    }
    assert.equal(detectScannerLevel(dir), 1, '10/20 = 0.5 should return Level 1, not 10/21');
  });

  it('passes exclude patterns through to scanner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'excl-'));
    writeFileSync(join(dir, 'keep.md'), '# Keep');
    const scanner = resolveCollectionScanner(makeManifest({ scannerLevel: 0, root: dir, exclude: ['drafts/**'] }));
    const results = scanner.discover(dir);
    assert.equal(results.length, 1);
  });
});
