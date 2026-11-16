import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { EmbeddingService } from '../../dist/domains/memory/EmbeddingService.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import {
  logVectorSearchDegradesTo,
  onVectorSearchDegrade,
} from '../../dist/domains/memory/vector-search-degrade-report.js';
import { evidenceRoutes } from '../../dist/routes/evidence.js';

const config = {
  embedMode: 'on',
  embedModel: 'fixture/embedding',
  embedDim: 4,
  embedTimeoutMs: 100,
  maxModelMemMb: 800,
  embedUrl: 'http://127.0.0.1:19998',
};
const health = () => Response.json({ status: 'ok', model: config.embedModel, dim: 4 });
const refused = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
const drain = async () => {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
};

test('a ready provider loses readiness on connection failure and recovers through the existing 30s reprobe', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const service = new EmbeddingService(config);
  let online = true,
    probes = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/health')) {
      probes++;
      return health();
    }
    throw refused();
  });
  await service.load();
  assert.equal(service.isReady(), true);
  const error = refused();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/health')) {
      probes++;
      if (online) return health();
    }
    throw error;
  });
  online = false;
  await assert.rejects(service.embed(['synthetic']), (e) => e === error);
  assert.equal(service.isReady(), false, 'transport loss must retire previously healthy availability');
  await service.reprobeIfNeeded();
  assert.equal(probes, 1, 'do not add a probe storm after the failed request');
  t.mock.timers.tick(30_000);
  online = true;
  await service.reprobeIfNeeded();
  assert.equal(probes, 2);
  assert.equal(service.isReady(), true);
});

test('the sidecar resource-exit 503 retires provider readiness without changing the 800MiB policy', async (t) => {
  const service = new EmbeddingService(config);
  service.markReady();
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_model_mem_mb, 800);
    return Response.json({ detail: { code: 'memory_budget_exceeded' } }, { status: 503 });
  });
  await assert.rejects(service.embed(['synthetic']), /503/);
  assert.equal(service.isReady(), false);
});

test('a failed response stream also retires the provider after headers have arrived', async (t) => {
  const service = new EmbeddingService(config);
  service.markReady();
  const failure = new TypeError('embedding response terminated');
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure);
          },
        }),
      ),
  );
  await assert.rejects(service.embed(['synthetic']), (error) => error === failure);
  assert.equal(service.isReady(), false);
});

test('caller cancellation and request-scoped HTTP rejection do not declare the provider dead', async (t) => {
  const service = new EmbeddingService(config);
  service.markReady();
  const started = Promise.withResolvers();
  t.mock.method(
    globalThis,
    'fetch',
    async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve();
      }),
  );
  const controller = new AbortController(),
    reason = new DOMException('caller finished', 'AbortError');
  const pending = service.embed(['synthetic'], controller.signal);
  const rejection = pending.catch((e) => e);
  await started.promise;
  controller.abort(reason);
  assert.equal(await rejection, reason);
  assert.equal(service.isReady(), true);
  for (const status of [400, 408, 413, 429]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('controlled per-request refusal', { status }));
    await assert.rejects(service.embed(['synthetic']), new RegExp(String(status)));
    assert.equal(service.isReady(), true, `HTTP ${status} is not evidence of lost service`);
  }
});

test('a late failed request cannot invalidate a newer verified provider availability', async (t) => {
  const service = new EmbeddingService(config);
  service.markReady();
  const pending = Promise.withResolvers(),
    started = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/health')) return health();
    started.resolve();
    return pending.promise;
  });
  const attempt = service.embed(['synthetic']);
  const rejection = attempt.catch((e) => e);
  await started.promise;
  await service.load();
  const error = refused();
  pending.reject(error);
  assert.equal(await rejection, error);
  assert.equal(service.isReady(), true, 'new /health proof supersedes the older failed request');
});

test('a health check completed after dispose cannot reopen the retired provider', async (t) => {
  const service = new EmbeddingService(config);
  const pending = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const loading = service.load();
  service.dispose();
  pending.resolve(health());
  await loading;
  assert.equal(service.isReady(), false);
});

async function lifecycleFixture(t, fileBacked = false) {
  const root = mkdtempSync(join(tmpdir(), 'provider-loss-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(fileBacked ? join(root, 'evidence.sqlite') : ':memory:');
  await store.initialize();
  const builder = new IndexBuilder(store, root);
  const service = new EmbeddingService(config);
  const lifecycle = new MemoryEmbeddingLifecycle(store, builder, config, { createEmbeddingService: () => service });
  t.after(() => {
    lifecycle.deactivate();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let online = true,
    encodes = 0,
    probes = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) {
      probes++;
      if (!online) throw refused();
      return health();
    }
    encodes++;
    if (!online) throw refused();
    const { input } = JSON.parse(init.body);
    return Response.json({
      model: config.embedModel,
      data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
    });
  });
  assert.equal((await lifecycle.activate('on')).ok, true);
  await store.upsert([
    {
      anchor: 'fixture-document',
      kind: 'plan',
      status: 'active',
      title: 'Synthetic',
      sourceHash: 'source-1',
      updatedAt: '2026-11-15',
    },
  ]);
  builder.startPassageEmbeddingWarmup = () => {};
  return {
    store,
    builder,
    service,
    lifecycle,
    setOnline: (value) => {
      online = value;
    },
    counts: () => ({ encodes, probes }),
  };
}

test('post-ready catch-up loss becomes degraded and the existing retry resumes pending work without a restart', async (t) => {
  const f = await lifecycleFixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  f.setOnline(false);
  await assert.rejects(f.lifecycle.catchUpAfterReady(), /fetch failed/);
  assert.equal(f.lifecycle.getStatus(), 'degraded');
  assert.equal(f.service.isReady(), false);
  assert.equal(f.lifecycle.getFailureReason(), 'service_not_ready');
  assert.equal(f.lifecycle.getVectorStore().count(), 0);
  // A publication callback during outage cannot erase the pending retry.
  await f.lifecycle.catchUpAfterReady();
  assert.equal(f.counts().encodes, 1);
  t.mock.timers.tick(30_000);
  await drain();
  assert.equal(f.service.isReady(), false);
  f.setOnline(true);
  t.mock.timers.tick(30_000);
  await drain();
  assert.equal(f.lifecycle.getStatus(), 'ready');
  assert.equal(
    f.lifecycle.getVectorStore().count(),
    1,
    'recovery must perform the still-pending document, not just change a banner',
  );
  assert.equal(f.counts().encodes, 2);
  assert.equal(
    f.store.getDb().prepare('SELECT source_hash FROM document_vector_sources WHERE anchor=?').get('fixture-document')
      .source_hash,
    'source-1',
  );
});

test('deactivate during an outage retires the existing recovery work', async (t) => {
  const f = await lifecycleFixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  f.setOnline(false);
  await assert.rejects(f.lifecycle.catchUpAfterReady());
  const before = f.counts();
  f.lifecycle.deactivate();
  t.mock.timers.tick(90_000);
  await drain();
  assert.deepEqual(f.counts(), before);
  assert.equal(f.lifecycle.getStatus(), 'off');
});

test('publication callbacks preserve the first outage timer and recover once at its original deadline', async (t) => {
  const f = await lifecycleFixture(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const recoveryTimers = [],
    setTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args);
    if (delay === 30_000) recoveryTimers.push(timer);
    return timer;
  });
  f.setOnline(false);
  await assert.rejects(f.lifecycle.catchUpAfterReady(), /fetch failed/);
  assert.equal(recoveryTimers.length, 1);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(5_000);
    await f.lifecycle.catchUpAfterReady();
  }
  assert.equal(recoveryTimers.length, 1, 'publication must coalesce into the original timer, not replace it');
  assert.deepEqual(f.counts(), { encodes: 1, probes: 1 });
  f.setOnline(true);
  t.mock.timers.tick(4_999);
  await drain();
  assert.equal(f.service.isReady(), false, 'do not recover before the original cooldown expires');
  t.mock.timers.tick(1);
  await drain();
  assert.equal(f.lifecycle.getStatus(), 'ready');
  assert.equal(f.lifecycle.getVectorStore().count(), 1);
  assert.deepEqual(f.counts(), { encodes: 2, probes: 2 }, 'the original 30s boundary performs one recovery');
  t.mock.timers.tick(30_000);
  await drain();
  assert.deepEqual(f.counts(), { encodes: 2, probes: 2 }, 'no duplicate recovery remains queued');
});

test('the existing status HTTP surface follows lost provider availability while retaining stored vectors', async (t) => {
  const f = await lifecycleFixture(t);
  await f.lifecycle.catchUpAfterReady();
  f.store
    .getDb()
    .prepare('INSERT INTO edges(from_anchor,to_anchor,relation) VALUES(?,?,?)')
    .run('fixture-document', 'fixture-document', 'synthetic');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(evidenceRoutes, { evidenceStore: f.store, getEmbeddingService: () => f.lifecycle.getService() });
  const before = (await app.inject({ method: 'GET', url: '/api/evidence/status' })).json();
  assert.equal(before.healthy, true);
  assert.equal(before.passage_vectors_supported, true);
  assert.equal(before.functionalStatus, 'ok');
  f.setOnline(false);
  await assert.rejects(f.service.embed(['synthetic']), /fetch failed/);
  const after = (await app.inject({ method: 'GET', url: '/api/evidence/status' })).json();
  assert.equal(after.healthy, true, 'the database health contract remains independent');
  assert.equal(after.passage_vectors_supported, false);
  assert.equal(after.functionalStatus, 'degraded');
  assert.ok(after.configWarnings.some(({ code }) => code === 'vec_table_missing'));
  assert.equal(after.vectors_count, before.vectors_count, 'outage must not discard persisted geometry');
  // This is the existing publication/catch-up entry, not a new service restart owner.
  await f.lifecycle.catchUpAfterReady();
});

test('real file-worker query RPC observes loss and existing catch-up restores semantic reads with the same vectors', async (t) => {
  const f = await lifecycleFixture(t, true);
  const anchor = 'thread-provider-loss';
  await f.store.upsert([{ anchor, kind: 'thread', status: 'active', title: 'Synthetic', updatedAt: '2026-11-15' }]);
  f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run(anchor, 'msg-synthetic', 'synthetic source', '2026-11-15');
  f.lifecycle.getPassageVectorStore().upsert(JSON.stringify([anchor, 'msg-synthetic']), new Float32Array([1, 0, 0, 0]));
  await f.lifecycle.catchUpAfterReady();
  const vectorCount = f.lifecycle.getVectorStore().count();
  const degrades = [];
  t.after(onVectorSearchDegrade((record) => degrades.push(record)));
  f.setOnline(false);
  const snapshots = [];
  const result = await f.store.searchMessagePassages('synthetic', {
    visibleThreadIds: ['provider-loss'],
    mode: 'hybrid',
    deadlineAt: Date.now() + 15_000,
    onReadSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  assert.ok(snapshots.at(-1).pid);
  assert.equal(result.meta.degraded, true);
  assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
  // The worker's stderr is dropped when its job succeeds; the reason has to arrive over IPC.
  assert.deepEqual(
    degrades.map((record) => [record.stage, record.errorCategory, record.errorName]),
    [['message_passage_hybrid', 'embed_api_unreachable', 'TypeError']],
  );
  assert.equal(f.service.isReady(), false, 'a worker RPC rejection must invalidate its actual parent provider');
  assert.equal(f.lifecycle.getStatus(), 'degraded');
  const requests = f.counts().encodes;
  // Advance only the existing provider cooldown; no inference or 30s real wait.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(30_000);
  f.setOnline(true);
  await f.lifecycle.catchUpAfterReady();
  assert.equal(f.lifecycle.getStatus(), 'ready');
  assert.equal(f.lifecycle.getVectorStore().count(), vectorCount);
  const recovered = await f.store.searchMessagePassages('synthetic', {
    visibleThreadIds: ['provider-loss'],
    mode: 'hybrid',
    deadlineAt: Date.now() + 15_000,
  });
  assert.equal(recovered.meta.degraded, false);
  assert.equal(recovered.meta.effectiveMode, 'hybrid');
  assert.ok(f.counts().encodes > requests);
  assert.equal(degrades.length, 1, 'a search that did not degrade reports nothing');
});

test('a document search degraded inside the real file worker reports its reason to the parent', async (t) => {
  // The 2026-11-15 19:10 PST shape: scope=docs, mode=hybrid, answered 200 with lexical results.
  const f = await lifecycleFixture(t, true);
  await f.lifecycle.catchUpAfterReady();
  const degrades = [];
  t.after(onVectorSearchDegrade((record) => degrades.push(record)));
  f.setOnline(false);
  const result = await f.store.searchWithMeta('Synthetic', { mode: 'hybrid', deadlineAt: Date.now() + 15_000 });
  assert.equal(result.meta.degraded, true);
  assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
  assert.deepEqual(
    degrades.map((record) => [record.stage, record.errorCategory, record.errorName]),
    [['summary_hybrid', 'embed_api_unreachable', 'TypeError']],
  );
  assert.ok(!JSON.stringify(degrades[0]).includes('Synthetic'), 'the query is never part of the record');
});

test('a provider error that echoes the query cannot carry it from the real file worker into the API log', async (t) => {
  // Review probe for #7145: the 503 body repeats its input on a line shaped like a stack frame.
  // EmbeddingService puts the body into the Error; the worker receives it over the embedding RPC.
  const f = await lifecycleFixture(t, true);
  await f.lifecycle.catchUpAfterReady();
  const rows = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => rows.push(JSON.parse(line)) } } });
  t.after(logVectorSearchDegradesTo(app.log));
  t.after(() => app.close());
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/health')) return health();
    const { input } = JSON.parse(init.body);
    return new Response(`provider rejected text\n    at ${input[0]}`, {
      status: 503,
      statusText: 'Service Unavailable',
    });
  });
  const loggedFor = async (query) => {
    rows.length = 0;
    f.service.markReady();
    const result = await f.store.searchWithMeta(query, { mode: 'hybrid', deadlineAt: Date.now() + 15_000 });
    assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
    const logged = rows.filter((row) => row.module === 'memory-vector-search');
    assert.equal(logged.length, 1, 'the worker report reaches the real logger exactly once');
    assert.ok(!JSON.stringify(logged[0]).includes(query), 'no part of the query is logged');
    const { time: _time, pid: _pid, hostname: _hostname, ...fields } = logged[0];
    return fields;
  };
  const first = await loggedFor('PRIVATE_QUERY_SENTINEL_7831');
  assert.deepEqual(first, {
    level: 40,
    module: 'memory-vector-search',
    stage: 'summary_hybrid',
    errorName: 'Error',
    errorCode: null,
    errorCategory: 'embed_api_http_503',
    msg: 'Vector search degraded to lexical',
  });
  // Nothing in the line depends on the text: a reader cannot test candidate queries against it.
  assert.deepEqual(await loggedFor('UNRELATED_QUERY_4402'), first);
});

test('vector tables the worker cannot open are reported, and only to a search that asked for vectors', async (t) => {
  const f = await lifecycleFixture(t, true);
  await f.lifecycle.catchUpAfterReady();
  const degrades = [];
  t.after(onVectorSearchDegrade((record) => degrades.push(record)));
  // The parent's snapshot now names a geometry the stored tables do not have.
  const model = f.service.getModelInfo();
  f.service.getModelInfo = () => ({ ...model, dim: model.dim + 1 });

  const lexical = await f.store.searchWithMeta('Synthetic', { deadlineAt: Date.now() + 15_000 });
  assert.equal(lexical.meta.degraded, false);
  assert.deepEqual(degrades, [], 'a lexical search never wanted the accelerator');

  const hybrid = await f.store.searchWithMeta('Synthetic', { mode: 'hybrid', deadlineAt: Date.now() + 15_000 });
  assert.equal(hybrid.meta.degraded, true);
  assert.equal(hybrid.meta.degradeReason, 'passage_embedding_unavailable');
  assert.deepEqual(
    degrades.map((record) => [record.stage, record.errorCategory]),
    [['vector_generation_open', 'vector_generation_unavailable']],
  );
});
