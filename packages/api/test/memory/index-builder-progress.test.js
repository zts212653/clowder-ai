import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('IndexBuilder rebuild progress callback', () => {
  it('reports phase progress during rebuild', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const dir = mkdtempSync(join(tmpdir(), 'idx-prog-'));
    const docsDir = join(dir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    writeFileSync(
      join(docsDir, 'features', 'F001-test.md'),
      ['---', 'feature_ids: [F001]', 'doc_kind: spec', '---', '# F001: Test', 'Summary text.'].join('\n'),
    );

    const dbPath = join(dir, 'evidence.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);

    const phases = [];
    await builder.rebuild({
      onProgress: (phase, percent) => phases.push({ phase, percent }),
    });

    assert.ok(phases.length >= 2, `should report multiple progress updates, got ${phases.length}`);
    assert.ok(
      phases.some((p) => p.phase === 'scanning'),
      'should report scanning phase',
    );
    assert.ok(
      phases.some((p) => p.phase === 'indexing'),
      'should report indexing phase',
    );
    const last = phases[phases.length - 1];
    assert.equal(last.percent, 100, 'final progress should be 100%');
  });

  it('works without onProgress (backward compatible)', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const dir = mkdtempSync(join(tmpdir(), 'idx-prog-'));
    const docsDir = join(dir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });
    writeFileSync(
      join(docsDir, 'features', 'F002-test.md'),
      ['---', 'feature_ids: [F002]', 'doc_kind: spec', '---', '# F002: Test2', 'More text.'].join('\n'),
    );

    const dbPath = join(dir, 'evidence.sqlite');
    const store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
    const builder = new IndexBuilder(store, docsDir);

    const result = await builder.rebuild();
    assert.ok(result.docsIndexed >= 1);
    assert.ok(result.durationMs >= 0);
  });
});
