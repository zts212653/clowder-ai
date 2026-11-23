import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { test } from 'node:test';
import { reconcileGenerationInvalidations } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { vectorGenerationTables } from '../../dist/domains/memory/vector-generation-tables.js';
import { onVectorReadRepeat, onVectorSearchDegrade } from '../../dist/domains/memory/vector-search-degrade-report.js';
import { cohortFixture, model } from './g0-ready-tail-fixture.js';

async function readyIndex(t) {
  const f = await cohortFixture(t);
  const { lifecycle } = f.boot();
  assert.equal((await lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  const read = (options = {}) =>
    f.store.searchWithMeta('nocturne', { mode: 'hybrid', limit: 50, deadlineAt: Date.now() + 60_000, ...options });
  await read();
  const repeats = [];
  t.after(onVectorReadRepeat((record) => repeats.push(record)));
  const insert = f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  const write = (id) => insert.run('initial-0', id, `piano passage ${id}`, '2026-11-16');
  return { f, read, repeats, write };
}

for (const change of ['rebound', 'quarantined-and-recovered']) {
  test(`a projection ${change} while the read pool settles cannot authorize the repeat`, async (t) => {
    const { f, read, repeats, write } = await readyIndex(t);
    let probes = 0;
    f.hooks.duringProbe = () => {
      if (probes++ === 0) write('initial-retirement');
    };
    let changed = false;
    t.after(
      onVectorSearchDegrade((record) => {
        if (record.attempt !== 1 || changed) return;
        // The first attempt has been classified, but its repeat waits a turn for the pool.
        // Runtime lifecycle/writer events can run in this same dispatch gap.
        setImmediate(() => {
          if (change === 'rebound') {
            const previous = f.store.embedDeps;
            f.store.setEmbedDeps(undefined);
            f.store.setEmbedDeps({ ...previous });
          } else {
            f.quarantineFromAnotherConnection();
            reconcileGenerationInvalidations(f.store.getDb(), vectorGenerationTables());
          }
          changed = true;
        });
      }),
    );

    const result = await read();

    assert.equal(changed, true, 'the lifecycle change ran before publication');
    assert.equal(probes, 1, 'the old permission must not borrow the replacement or recovered projection');
    assert.equal(result.meta.degraded, true);
    assert.deepEqual(
      repeats.map((record) => record.outcome),
      ['skipped_unavailable'],
    );
  });
}

test('cancellation during the final lexical read records cancellation, not a completed degradation', async (t) => {
  const { f, read, repeats, write } = await readyIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => write(`retire-${++probes}`);
  const controller = new AbortController();
  const reason = new Error('caller cancelled the final lexical read');
  let reads = 0;
  const onJob = ({ kind }) => {
    if (kind === 'search' && ++reads === 3) controller.abort(reason);
  };
  subscribe('cat-cafe.memory-process', onJob);
  t.after(() => unsubscribe('cat-cafe.memory-process', onJob));

  await assert.rejects(read({ signal: controller.signal }), (error) => error === reason);

  assert.equal(reads, 3, 'first attempt, repeat, then a fresh lexical read');
  assert.equal(probes, 2);
  assert.deepEqual(
    repeats.map((record) => record.outcome),
    ['cancelled'],
  );
});

test('a final lexical worker failure is not reported as a completed degradation', async (t) => {
  const { f, read, repeats, write } = await readyIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => write(`retire-${++probes}`);
  let reads = 0;
  const onJob = ({ kind, pid }) => {
    // Only the child just dispatched by this synthetic search is terminated.
    if (kind === 'search' && ++reads === 3) process.kill(pid, 'SIGKILL');
  };
  subscribe('cat-cafe.memory-process', onJob);
  t.after(() => unsubscribe('cat-cafe.memory-process', onJob));

  await assert.rejects(read(), /Memory process exited/);

  assert.equal(reads, 3);
  assert.equal(probes, 2);
  assert.deepEqual(
    repeats.map((record) => record.outcome),
    ['lexical_failed'],
  );
});
