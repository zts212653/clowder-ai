import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFiles, GENERATED_DOC_DIRS, KIND_DIRS } from '../scanner-discovery-pure.js';

function writeFixtureFile(root: string, relativePath: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '# Fixture\n\nBody\n', 'utf8');
}

function relativeResults(root: string): Array<{ path: string; kind: string }> {
  return discoverFiles(root)
    .map((file) => ({
      path: relative(root, file.path).split('\\').join('/'),
      kind: file.kind,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

describe('F243 B-0 scanner discovery pure function', () => {
  it('keeps F102 docs discovery behavior available without the API runtime stack', () => {
    const docsRoot = mkdtempSync(join(tmpdir(), 'f243-scanner-discovery-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'f243-scanner-outside-'));

    try {
      writeFixtureFile(docsRoot, 'features/F999-good.md');
      writeFixtureFile(docsRoot, 'features/nested/F998-nested.md');
      writeFixtureFile(docsRoot, 'decisions/ADR-999.md');
      writeFixtureFile(docsRoot, 'architecture/memory-system-overview.md');
      writeFixtureFile(docsRoot, 'archive/2026-06-01/features/F001-archived.md');
      writeFixtureFile(docsRoot, 'lessons-learned.md');
      writeFixtureFile(docsRoot, 'diagrams/map.svg');
      writeFixtureFile(docsRoot, 'custom/prior-art.md');
      writeFixtureFile(docsRoot, 'mailbox/inbox.md');
      writeFixtureFile(docsRoot, 'features/generated.tmp');
      writeFixtureFile(docsRoot, 'features/exported-threads/skip.md');
      writeFixtureFile(docsRoot, 'exported-threads/root-skip.md');

      const symlinkTarget = join(outsideRoot, 'linked.md');
      writeFileSync(symlinkTarget, '# Linked\n', 'utf8');
      symlinkSync(symlinkTarget, join(docsRoot, 'features', 'linked.md'));
      expect(lstatSync(join(docsRoot, 'features', 'linked.md')).isSymbolicLink()).toBe(true);

      expect(relativeResults(docsRoot)).toEqual([
        { path: 'architecture/memory-system-overview.md', kind: 'architecture' },
        { path: 'archive/2026-06-01/features/F001-archived.md', kind: 'feature' },
        { path: 'custom/prior-art.md', kind: 'plan' },
        { path: 'decisions/ADR-999.md', kind: 'decision' },
        { path: 'diagrams/map.svg', kind: 'plan' },
        { path: 'features/F999-good.md', kind: 'feature' },
        { path: 'features/nested/F998-nested.md', kind: 'feature' },
        { path: 'lessons-learned.md', kind: 'plan' },
      ]);
    } finally {
      rmSync(docsRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('exports the scanner constants needed by CatCafeScanner and F243 scope resolver', () => {
    expect(KIND_DIRS.features).toBe('feature');
    expect(KIND_DIRS.architecture).toBe('architecture');
    expect(KIND_DIRS.discussions).toBe('discussion');
    expect([...GENERATED_DOC_DIRS]).toEqual(['exported-threads']);
  });
});
