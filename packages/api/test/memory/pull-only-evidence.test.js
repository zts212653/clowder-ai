import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function createStore() {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  await store.upsert([
    {
      anchor: 'reflection-candidate:pull-only-test',
      kind: 'discussion',
      status: 'active',
      title: 'Reflection candidate pull-only sentinel',
      summary: 'candidate must remain visible to deliberate pull and closed to automatic push',
      keywords: ['reflection', 'candidate', 'pull-only-sentinel'],
      updatedAt: '2026-07-20T12:00:00.000Z',
      authority: 'candidate',
      activation: 'pull_only',
    },
  ]);
  return store;
}

describe('F271 pull-only evidence activation', () => {
  test('fails closed by default and becomes visible only with explicit pull opt-in', async () => {
    const store = await createStore();
    const query = 'pull-only-sentinel';

    assert.deepEqual(await store.search(query, { mode: 'lexical' }), []);
    assert.deepEqual(store.queryAlwaysOn(), [], 'bootstrap injection must not see pull-only candidates');
    const pulled = await store.search(query, { mode: 'lexical', includePullOnly: true });
    assert.equal(pulled.length, 1);
    assert.equal(pulled[0].authority, 'candidate');
    assert.equal(pulled[0].activation, 'pull_only');
  });

  test('guards exact-anchor, hybrid fallback, and raw retrieval as well as ordinary FTS', async () => {
    const store = await createStore();
    const anchor = 'reflection-candidate:pull-only-test';

    for (const options of [
      { mode: 'lexical' },
      { mode: 'hybrid' },
      { mode: 'semantic' },
      { mode: 'lexical', depth: 'raw' },
    ]) {
      assert.deepEqual(await store.search(anchor, options), [], `default push leaked for ${JSON.stringify(options)}`);
      const pulled = await store.search(anchor, { ...options, includePullOnly: true });
      assert.equal(pulled.length, 1, `explicit pull missed for ${JSON.stringify(options)}`);
    }
  });

  test('keeps the candidate label and downranks pull-only evidence without an authority feature flag', async () => {
    const store = await createStore();
    await store.upsert([
      {
        anchor: 'docs/features/F271-validated-contract.md',
        kind: 'feature',
        status: 'active',
        title: 'Reflection candidate pull-only sentinel',
        summary: 'candidate must remain visible to deliberate pull and closed to automatic push',
        keywords: ['reflection', 'candidate', 'pull-only-sentinel'],
        updatedAt: '2026-07-20T12:00:00.000Z',
        authority: 'validated',
        activation: 'query',
      },
    ]);

    const previous = process.env.F163_AUTHORITY_BOOST;
    delete process.env.F163_AUTHORITY_BOOST;
    try {
      const pulled = await store.search('pull-only-sentinel', {
        mode: 'lexical',
        includePullOnly: true,
        limit: 10,
      });
      assert.equal(pulled.length, 2);
      assert.equal(pulled[0].authority, 'validated');
      assert.equal(pulled[1].authority, 'candidate');
      assert.equal(pulled[1].activation, 'pull_only');
    } finally {
      if (previous === undefined) delete process.env.F163_AUTHORITY_BOOST;
      else process.env.F163_AUTHORITY_BOOST = previous;
    }
  });
});
