import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddingService } from '../../dist/domains/memory/EmbeddingService.js';
import { onVectorReadRepeat, onVectorSearchDegrade } from '../../dist/domains/memory/vector-search-degrade-report.js';
import { cohortFixture, model } from './g0-ready-tail-fixture.js';

// Task528's no-op preparation probe retired a healthy capability without changing sources.
// Exercise the public search consumers: a word absent from every source can only return vector hits.
// Real file-backed stores/read processes; the provider is a stub. Queue overlap uses barriers, no sleep.
function barrier() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t, kind, service) {
  const f = await cohortFixture(t);
  await f.store.upsert([
    { anchor: 'thread-music', kind: 'thread', status: 'active', title: 'piano thread', updatedAt: '2026-11-17' },
  ]);
  f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run('thread-music', 'msg-one', 'A piano composition', '2026-11-17');
  let duringQuery;
  const { lifecycle } = f.boot(
    async (texts) => {
      if (!texts.some((text) => text.includes('nocturne')) || !duringQuery) return;
      const action = duringQuery;
      duringQuery = undefined;
      await action();
    },
    service ? { createEmbeddingService: () => service } : undefined,
  );
  assert.equal((await lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  assert.equal(f.coverage().ready, true);
  const seen = { degrades: [], repeats: [] };
  t.after(onVectorSearchDegrade((event) => seen.degrades.push(event)));
  t.after(onVectorReadRepeat((event) => seen.repeats.push(event)));
  const search = async () => {
    const options = { mode: 'hybrid', limit: 50, deadlineAt: Date.now() + 15_000 };
    if (kind === 'documents') {
      const found = await f.store.searchWithMeta('nocturne', options);
      return { meta: found.meta, hits: found.items.map((item) => item.anchor) };
    }
    const found = await f.store.searchMessagePassages('nocturne', { ...options, visibleThreadIds: ['music'] });
    return { meta: found.meta, hits: found.passages.map((passage) => passage.passageId) };
  };
  // Warm the process independently of the overlap under test; no cache or timeout assertion.
  const baseline = await search();
  assert.equal(baseline.meta.degraded, false);
  assert.ok(baseline.hits.length > 0, 'stored vectors are visible before the no-op preparation');
  seen.degrades.length = 0;
  seen.repeats.length = 0;
  return {
    f,
    lifecycle,
    seen,
    search,
    overlapQuery: (action) => {
      duringQuery = action;
    },
  };
}

test('a provider 503 while preparation is queued stays unavailable until healthy preparation republishes', async (t) => {
  let failEncode = false;
  const service = new EmbeddingService({
    embedMode: 'on',
    embedModel: model.modelId,
    embedModelRev: model.modelRev,
    embedDim: model.dim,
    generationId: 'g0',
    embedTimeoutMs: 1000,
    maxModelMemMb: 32,
    embedUrl: 'http://127.0.0.1:19998',
  });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({ status: 'ok', model: model.modelId, dim: model.dim, generation_id: 'g0' });
    if (failEncode) return Response.json({ detail: 'controlled unavailable provider' }, { status: 503 });
    const { input } = JSON.parse(init.body);
    return Response.json({
      model: model.modelId,
      generation_id: 'g0',
      data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
    });
  });
  const { f, lifecycle, search } = await fixture(t, 'documents', service);
  const entered = barrier(),
    release = barrier(),
    queued = barrier();
  const originalExclusive = f.store.runExclusive.bind(f.store);
  const blocker = originalExclusive(async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  f.store.runExclusive = (action) => {
    const pending = originalExclusive(action);
    queued.release();
    return pending;
  };
  const preparation = lifecycle.catchUpAfterReady();
  try {
    await queued.promise;
    failEncode = true;
    await assert.rejects(service.embed(['controlled availability probe']), /503/);
    assert.equal(service.isReady(), false);
  } finally {
    release.release();
    await blocker;
    await preparation;
    f.store.runExclusive = originalExclusive;
  }
  assert.equal((await search()).meta.degraded, true);
  failEncode = false;
  await service.load();
  assert.equal(service.isReady(), true);
  assert.equal((await search()).meta.degraded, true, 'provider readiness alone cannot vouch for skipped preparation');
  assert.equal((await lifecycle.catchUpAfterReady()).docsEmbedded, 0);
  const recovered = await search();
  assert.equal(recovered.meta.degraded, false);
  assert.ok(recovered.hits.length > 0);
});

for (const kind of ['documents', 'messages']) {
  test(`${kind}: an unchanged preparation during query encoding preserves semantic hits`, async (t) => {
    const { lifecycle, seen, search, overlapQuery } = await fixture(t, kind);
    let prepared;
    overlapQuery(async () => {
      prepared = await lifecycle.catchUpAfterReady();
    });

    const result = await search();

    assert.equal(prepared?.docsEmbedded, 0, 'the concurrent producer had no source changes');
    t.diagnostic(JSON.stringify({ kind, overlap: 'completed-during-encoding', result, seen }));
    assert.equal(result.meta.degraded, false, 'a no-op producer must not turn a healthy vector search lexical');
    assert.ok(result.hits.length > 0, 'a word absent from source text still gets vector hits');
    assert.deepEqual(seen.degrades, []);
    assert.deepEqual(seen.repeats, [], 'unchanged preparation requires no compensating read');
  });

  test(`${kind}: an unchanged preparation queued behind other work keeps semantic search available`, async (t) => {
    const { f, lifecycle, seen, search } = await fixture(t, kind);
    const entered = barrier();
    const release = barrier();
    const queued = barrier();
    const originalExclusive = f.store.runExclusive.bind(f.store);
    const blocker = originalExclusive(async () => {
      entered.release();
      await release.promise;
    });
    await entered.promise;
    f.store.runExclusive = (action) => {
      const pending = originalExclusive(action);
      queued.release();
      return pending;
    };
    const preparation = lifecycle.catchUpAfterReady();
    let result;
    let prepared;
    try {
      await queued.promise;
      result = await search();
    } finally {
      release.release();
      await blocker;
      prepared = await preparation;
      f.store.runExclusive = originalExclusive;
    }

    assert.equal(prepared.docsEmbedded, 0);
    t.diagnostic(JSON.stringify({ kind, overlap: 'waiting-in-queue', result, seen }));
    assert.equal(result.meta.degraded, false, 'queuing a no-op producer must not withdraw usable vectors');
    assert.ok(result.hits.length > 0);
    assert.deepEqual(seen.degrades, []);
    assert.deepEqual(seen.repeats, []);
  });
}
