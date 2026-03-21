/**
 * F102 Phase B: Eval Runner — Recall@5 evaluation against real docs index
 * AC-B7: memory_eval_corpus.yaml evaluation set
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

describe('Eval Corpus: Recall@5', () => {
  let SqliteEvidenceStore;
  let IndexBuilder;
  let store;

  before(async () => {
    const storeMod = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    SqliteEvidenceStore = storeMod.SqliteEvidenceStore;
    const builderMod = await import('../../dist/domains/memory/IndexBuilder.js');
    IndexBuilder = builderMod.IndexBuilder;

    // Build real index from docs/ — resolve relative to repo root (not process.cwd() which is packages/api)
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const docsRoot = join(import.meta.dirname, '../../../../docs');
    const builder = new IndexBuilder(store, docsRoot);
    await builder.rebuild({ force: true });
  });

  after(() => {
    if (store) store.close();
  });

  function loadCorpus() {
    const yamlPath = join(import.meta.dirname, 'memory_eval_corpus.yaml');
    const raw = readFileSync(yamlPath, 'utf-8');
    // Minimal YAML parser for our simple structure
    return parseEvalCorpus(raw);
  }

  it('Recall@5 >= 80% across all recall queries', async () => {
    const corpus = loadCorpus();
    const recallQueries = corpus.filter((q) => q.expected_anchors?.length > 0);

    let totalExpected = 0;
    let totalHits = 0;
    const misses = [];

    for (const q of recallQueries) {
      const results = await store.search(q.query, { limit: 5 });
      const resultAnchors = results.map((r) => r.anchor);

      for (const expected of q.expected_anchors) {
        totalExpected++;
        if (resultAnchors.includes(expected)) {
          totalHits++;
        } else {
          misses.push({ id: q.id, query: q.query, expected, got: resultAnchors });
        }
      }
    }

    const recall = totalHits / totalExpected;
    console.log(`Recall@5: ${totalHits}/${totalExpected} = ${(recall * 100).toFixed(1)}%`);
    if (misses.length > 0) {
      console.log('Misses:', JSON.stringify(misses, null, 2));
    }

    assert.ok(recall >= 0.8, `Recall@5 = ${(recall * 100).toFixed(1)}% < 80% threshold`);
  });

  it('precision: no archive/mailbox paths in results', async () => {
    const corpus = loadCorpus();
    const precisionQueries = corpus.filter((q) => q.must_not_contain_paths?.length > 0);

    for (const q of precisionQueries) {
      const results = await store.search(q.query, { limit: 5 });
      for (const r of results) {
        if (r.sourcePath) {
          for (const forbidden of q.must_not_contain_paths) {
            assert.ok(
              !r.sourcePath.includes(forbidden),
              `Query "${q.query}" returned forbidden path "${r.sourcePath}" (contains "${forbidden}")`,
            );
          }
        }
      }
    }
  });
});

// ── Minimal YAML parser for eval corpus ──
function parseEvalCorpus(raw) {
  const queries = [];
  const blocks = raw.split(/\n {2}- id: /).slice(1);

  for (const block of blocks) {
    const lines = `id: ${block}`.split('\n');
    const entry = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('id: ')) entry.id = trimmed.slice(4);
      if (trimmed.startsWith('query: ')) entry.query = trimmed.slice(7).replace(/^"/, '').replace(/"$/, '');
      if (trimmed.startsWith('expected_anchors: ')) {
        const arrMatch = trimmed.match(/\[(.+)]/);
        if (arrMatch) entry.expected_anchors = arrMatch[1].split(',').map((s) => s.trim());
      }
      if (trimmed.startsWith('must_not_contain_paths: ')) {
        const arrMatch = trimmed.match(/\[(.+)]/);
        if (arrMatch) entry.must_not_contain_paths = arrMatch[1].split(',').map((s) => s.trim().replace(/"/g, ''));
      }
      if (trimmed.startsWith('note: ')) entry.note = trimmed.slice(6).replace(/^"/, '').replace(/"$/, '');
    }

    if (entry.id) queries.push(entry);
  }

  return queries;
}
