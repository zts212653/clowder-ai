import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { test } from 'node:test';
import { reconcileGenerationInvalidations } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { vectorGenerationTables } from '../../dist/domains/memory/vector-generation-tables.js';
import { onVectorReadRepeat, onVectorSearchDegrade } from '../../dist/domains/memory/vector-search-degrade-report.js';
import { cohortFixture, model } from './g0-ready-tail-fixture.js';

// 2026-11-16 23:28:44 UTC, boot92: a hybrid search arrived, a thread flush committed 504 ms later,
// and the search came back lexical-only with two `embedding_availability` records of category
// `vector_projection_not_ready`. The index was bound and the provider healthy.
//
// One snapshot of the invalidation epoch fences a search from dispatch to publication, so any
// source write in between retires its vectors. The fence stays. A search retired that way is now
// read once more under a new snapshot, within a bounded window.
//
// Searches use a word that occurs in no fixture text unless a test says otherwise: hits can then
// only come from stored vectors.

const SEARCH_JOBS = new Set(['search', 'message-search']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boundIndex(t, encode) {
  const f = await cohortFixture(t);
  const { lifecycle } = f.boot(encode);
  assert.equal((await lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
  const seen = { degrades: [], repeats: [], reads: [], pids: [] };
  t.after(onVectorSearchDegrade((record) => seen.degrades.push(record)));
  t.after(onVectorReadRepeat((record) => seen.repeats.push(record)));
  const onJob = (job) => {
    if (!SEARCH_JOBS.has(job.kind)) return;
    seen.reads.push(job.kind);
    seen.pids.push(job.pid);
  };
  subscribe('cat-cafe.memory-process', onJob);
  t.after(() => unsubscribe('cat-cafe.memory-process', onJob));
  const insert = f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  /** What a thread flush does to this store: one more passage, committed on the API's own connection. */
  const flush = (id) => insert.run('initial-0', id, `initial-0 piano passage ${id}`, '2026-11-16');
  const attempts = () => seen.degrades.map((record) => [record.stage, record.errorCategory, record.attempt]);
  const outcomes = () => seen.repeats.map((record) => record.outcome);
  /** Anchors only a stored vector can return. The deadline is far away: these tests are about the repeat's own limits. */
  const byVector = async (deadlineAt = Date.now() + 60_000) => {
    const result = await f.store.searchWithMeta('nocturne', { mode: 'hybrid', limit: 50, deadlineAt });
    return { meta: result.meta, anchors: result.items.map((item) => item.anchor) };
  };
  // Start the read worker now. A first attempt that has to fork it takes seconds on a busy machine,
  // and the policy then rightly declines to repeat; that is the budget test's subject, not every test's.
  await byVector();
  for (const list of Object.values(seen)) list.length = 0;
  return { f, lifecycle, seen, flush, attempts, outcomes, byVector };
}

/** Every record of one search carries the same random id, and nothing else ties it to the query. */
function assertOneOperation(seen, query) {
  const ids = new Set([...seen.degrades, ...seen.repeats].map((record) => record.operationId));
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify([seen.degrades, seen.repeats]).includes(query));
}

test('a source committed while a search probes the provider costs a second read, not the vectors', async (t) => {
  const { f, seen, flush, attempts, outcomes, byVector } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ === 0) flush('p-flushed');
  };

  const found = await byVector();

  assert.equal(f.coverage().missingPassages, 1, 'the flush landed');
  assert.deepEqual([found.meta.degraded, found.meta.degradeReason ?? null], [false, null]);
  assert.ok(found.anchors.includes('initial-0'), 'the hits are vector hits');
  // The lost attempt is on record as an attempt; the search itself did not degrade.
  assert.deepEqual(attempts(), [['embedding_availability', 'vector_projection_not_ready', 1]]);
  assert.deepEqual(outcomes(), ['recovered']);
  assert.deepEqual(seen.reads, ['search', 'search']);
  // The repeat must not spend its window starting a second worker process.
  assert.equal(seen.pids[1], seen.pids[0], 'the repeat runs on the worker the first attempt started');
  assertOneOperation(seen, 'nocturne');
});

test('a source committed while a search embeds its query is repeated the same way', async (t) => {
  let embedded = 0;
  let write;
  const { seen, flush, attempts, outcomes, byVector } = await boundIndex(t, async (texts) => {
    if (write && texts.some((text) => text.includes('nocturne')) && embedded++ === 0) write();
  });
  write = () => flush('p-flushed');

  const found = await byVector();

  assert.ok(embedded > 0, 'the search did embed its query');
  assert.deepEqual([found.meta.degraded, found.meta.degradeReason ?? null], [false, null]);
  assert.ok(found.anchors.includes('initial-0'));
  assert.deepEqual(attempts(), [['summary_hybrid', 'vector_projection_not_ready', 1]]);
  assert.deepEqual(outcomes(), ['recovered']);
  assert.deepEqual(seen.reads, ['search', 'search']);
});

test('a source committed after the worker finished, before the parent publishes, is repeated too', async (t) => {
  const { f, lifecycle, seen, attempts, outcomes } = await boundIndex(t);
  // A message search reports each read to its private observer before the parent's own check.
  await f.store.upsert([
    { anchor: 'thread-flushing', kind: 'thread', status: 'active', title: 'piano thread', updatedAt: '2026-11-16' },
  ]);
  const insert = f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  insert.run('thread-flushing', 'msg-1', 'piano message one', '2026-11-16');
  await lifecycle.catchUpAfterReady();
  for (let i = 0; i < 200 && !f.coverage().ready; i++) await sleep(25);
  assert.equal(f.coverage().ready, true);

  let flushed = 0;
  const search = () =>
    f.store.searchMessagePassages('piano', {
      visibleThreadIds: ['flushing'],
      mode: 'hybrid',
      deadlineAt: Date.now() + 15_000,
      onReadSnapshot: (snapshot) => {
        if (snapshot.outcome === 'fulfilled' && flushed++ === 0)
          insert.run('thread-flushing', 'msg-2', 'piano message two', '2026-11-16');
      },
    });
  const found = await search();

  assert.ok(flushed > 0);
  assert.deepEqual([found.meta.degraded, found.meta.effectiveMode], [false, 'hybrid']);
  assert.deepEqual(attempts(), [['projection_publication', 'vector_projection_not_ready', 1]]);
  assert.deepEqual(outcomes(), ['recovered']);
  assert.deepEqual(seen.reads, ['message-search', 'message-search']);
});

test('something forgotten during the repeat is not returned from an earlier read', async (t) => {
  const { f, seen, flush, outcomes } = await boundIndex(t);
  // "piano" is in every fixture title, so the lexical reads of both attempts hold initial-1.
  const byWord = () => f.store.searchWithMeta('piano', { mode: 'hybrid', limit: 50, deadlineAt: Date.now() + 60_000 });
  let probes = 0;
  f.hooks.duringProbe = async () => {
    probes++;
    if (probes === 1) flush('p-flushed');
    // The repeat's worker has read its lexical rows; now the document is really removed.
    if (probes === 2) await f.store.deleteByAnchor('initial-1');
  };

  const found = await byWord();
  const anchors = found.items.map((item) => item.anchor);

  assert.deepEqual(outcomes(), ['degraded_again']);
  assert.deepEqual([found.meta.degraded, found.meta.effectiveMode], [true, 'lexical']);
  assert.ok(anchors.includes('initial-0'), 'a lexical answer is still served');
  assert.ok(!anchors.includes('initial-1'), 'the forgotten document is in no returned result');
  assert.deepEqual(seen.reads, ['search', 'search', 'search'], 'the answer is a read started after the repeat');
});

test('a repeat retired again ends in the current lexical answer', async (t) => {
  const { f, seen, flush, attempts, outcomes, byVector } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => flush(`p-flushed-${probes++}`);

  const found = await byVector();

  assert.deepEqual(
    [found.meta.degraded, found.meta.degradeReason, found.meta.effectiveMode, found.anchors],
    [true, 'passage_embedding_unavailable', 'lexical', []],
  );
  assert.deepEqual(attempts(), [
    ['embedding_availability', 'vector_projection_not_ready', 1],
    ['embedding_availability', 'vector_projection_not_ready', 2],
  ]);
  assert.deepEqual(outcomes(), ['degraded_again']);
  assert.deepEqual(seen.reads, ['search', 'search', 'search']);
  assert.deepEqual(new Set(seen.pids).size, 1, 'all three reads use the one started worker');
  assertOneOperation(seen, 'nocturne');
});

test('a repeat that outlasts its window is stopped, and the search still answers before its deadline', async (t) => {
  const { f, seen, flush, outcomes } = await boundIndex(t);
  let probes = 0;
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  f.hooks.duringProbe = async () => {
    if (probes++ === 0) return flush('p-flushed');
    await stalled; // the repeat hangs on its provider
  };

  const started = Date.now();
  const found = await f.store.searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt: started + 60_000 });
  const elapsed = Date.now() - started;

  assert.deepEqual(outcomes(), ['repeat_stopped']);
  assert.deepEqual([found.meta.degraded, found.meta.effectiveMode], [true, 'lexical']);
  assert.ok(
    elapsed >= 1_000 && elapsed < 20_000,
    `the repeat had its own window, not the caller's 60 s: ${elapsed} ms`,
  );
  assert.ok(seen.repeats[0].repeatMs >= 1_000, `${seen.repeats[0].repeatMs} ms`);
  assert.deepEqual(seen.reads, ['search', 'search', 'search']);
});

test('a slow first attempt that leaves no time for a repeat degrades to a current lexical answer', async (t) => {
  const { f, seen, flush, outcomes } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = async () => {
    if (probes++ > 0) return;
    await sleep(2_000); // a 2 s first attempt: a repeat may take 4 s, and 2 s more are kept for the lexical read
    flush('p-flushed');
  };

  // 7 s in all, so at most 5 s are left after the first attempt: fewer than the 6 s it would take.
  const found = await f.store.searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt: Date.now() + 7_000 });

  assert.deepEqual(outcomes(), ['skipped_budget']);
  assert.deepEqual([found.meta.degraded, found.meta.degradeReason], [true, 'passage_embedding_unavailable']);
  assert.equal(probes, 1, 'no second vector attempt');
  assert.deepEqual(seen.reads, ['search', 'search'], 'the answer is a lexical read started after the write');
  assert.equal(seen.repeats[0].repeatMs, null);
  assert.ok(seen.repeats[0].firstAttemptMs >= 2_000);
});

test("the caller's deadline passing while the API thread is busy during the repeat ends the search in error", async (t) => {
  const { f, seen, flush, outcomes } = await boundIndex(t);
  // The repeat's window always ends before the caller's deadline, with a reserve. The deadline can
  // still pass inside the repeat when the API's main thread is blocked and no timer can fire.
  let probes = 0;
  let deadlineAt;
  f.hooks.duringProbe = () => {
    if (probes++ === 0) return flush('p-flushed');
    while (Date.now() <= deadlineAt) {
      /* a synchronous flush, a long GC pause */
    }
  };

  deadlineAt = Date.now() + 3_000;
  await assert.rejects(
    f.store.searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt }),
    (error) => error.code === 'deadline_exceeded' || error.name === 'TimeoutError',
  );
  await sleep(50);
  assert.deepEqual(outcomes(), ['cancelled']);
  assert.deepEqual(seen.reads, ['search', 'search'], 'no read follows the deadline');
});

test('a caller that cancels during the repeat gets its own reason back, and nothing is read afterwards', async (t) => {
  const { f, seen, flush, outcomes } = await boundIndex(t);
  const caller = new AbortController();
  const reason = new Error('caller went away');
  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ === 0) return flush('p-flushed');
    caller.abort(reason);
  };

  await assert.rejects(
    f.store.searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt: Date.now() + 10_000, signal: caller.signal }),
    (error) => error === reason,
  );
  await sleep(50);
  assert.deepEqual(outcomes(), ['cancelled']);
  assert.deepEqual(seen.reads, ['search', 'search']);
});

test('a store quarantined during the search is not read again', async (t) => {
  const { f, seen, outcomes, byVector } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ === 0) f.quarantineFromAnotherConnection();
  };

  const found = await byVector();

  assert.deepEqual([found.meta.degraded, found.meta.degradeReason], [true, 'passage_embedding_unavailable']);
  assert.deepEqual(outcomes(), [], 'a quarantine is not a source write');
  assert.deepEqual(
    seen.degrades.map((record) => [record.stage, record.attempt ?? null]),
    [['embedding_availability', null]],
    'the record is the final state of the search, as before',
  );
  assert.equal(probes, 1, 'no second vector attempt');
  assert.deepEqual(
    seen.reads,
    ['search', 'search'],
    'the projection changed mid-read: answer from a lexical read started now',
  );
});

test('a projection withdrawn during the search is not read again', async (t) => {
  const { f, seen, flush, outcomes, byVector } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ > 0) return;
    flush('p-flushed');
    f.store.setEmbedDeps(undefined); // the lifecycle unbinds: another model, another generation, a repair
  };

  const found = await byVector();

  assert.equal(found.meta.degraded, true);
  assert.deepEqual(outcomes(), []);
  assert.equal(probes, 1, 'no second vector attempt');
  assert.deepEqual(seen.reads, ['search', 'search']);
});

// #7189 gives a message search's optional vectors 2 s from the moment a worker starts on them, then
// reads lexically. The repeat is another vector read of the same search: it shares that one budget.

async function messageIndex(t, encode) {
  const bound = await boundIndex(t, encode);
  const { f, lifecycle } = bound;
  await f.store.upsert([
    { anchor: 'thread-flushing', kind: 'thread', status: 'active', title: 'piano thread', updatedAt: '2026-11-16' },
  ]);
  const insert = f.store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
  insert.run('thread-flushing', 'msg-1', 'piano message one', '2026-11-16');
  await lifecycle.catchUpAfterReady();
  for (let i = 0; i < 200 && !f.coverage().ready; i++) await sleep(25);
  assert.equal(f.coverage().ready, true);
  let flushes = 0;
  const flushMessage = () => insert.run('thread-flushing', `msg-late-${flushes++}`, 'piano message late', '2026-11-16');
  const search = (options = {}) =>
    f.store.searchMessagePassages('sonata', {
      visibleThreadIds: ['flushing'],
      mode: 'hybrid',
      deadlineAt: Date.now() + 60_000,
      ...options,
    });
  return { ...bound, flushMessage, search };
}

function hang(t) {
  let release;
  const stalled = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  return stalled;
}

test("a message search's vector budget also bounds a repeat that is the first to read vectors", async (t) => {
  const stalled = hang(t);
  const { f, seen, flushMessage, search, outcomes } = await messageIndex(t, async (texts) => {
    if (texts.some((text) => text.includes('sonata'))) await stalled; // the repeat's query embedding hangs
  });
  let probes = 0;
  f.hooks.duringProbe = async () => {
    if (probes++ > 0) return;
    await sleep(3_000); // the repeat's own 6 s window must outlast the 4 s vector budget
    flushMessage();
  };

  const found = await search();

  assert.deepEqual(
    [found.meta.degraded, found.meta.degradeReason, found.meta.effectiveMode],
    [true, 'passage_vector_budget_exhausted', 'lexical'],
  );
  assert.deepEqual(outcomes(), ['vector_budget_exhausted'], 'the outer budget completed its fresh lexical read');
  assert.ok(seen.repeats[0].repeatMs >= 4_000 && seen.repeats[0].repeatMs < 5_500, `${seen.repeats[0].repeatMs} ms`);
  assert.deepEqual(seen.reads, ['message-search', 'message-search', 'message-search']);
});

test('a repeat gets what the first attempt left of the vector budget, not a budget of its own', async (t) => {
  const stalled = hang(t);
  let embeds = 0;
  const { seen, flushMessage, search, outcomes } = await messageIndex(t, async (texts) => {
    if (!texts.some((text) => text.includes('sonata'))) return;
    if (embeds++ === 0) return sleep(2_000); // the first attempt uses at least half the shared budget
    await stalled; // the repeat hangs in its vector read
  });
  let published = 0;
  const found = await search({
    // The first attempt returns its vectors; a flush lands before the parent publishes them.
    onReadSnapshot: (snapshot) => {
      if (snapshot.outcome === 'fulfilled' && published++ === 0) flushMessage();
    },
  });

  assert.deepEqual(
    [found.meta.degradeReason, found.meta.effectiveMode],
    ['passage_vector_budget_exhausted', 'lexical'],
  );
  assert.deepEqual(outcomes(), ['vector_budget_exhausted']);
  // 4 s from the first vector start, of which the first attempt used at least 2 s. The repeat's
  // own window (twice the first attempt) ends later than that, so the budget is what stops it. A budget
  // of its own would let the repeat run 4 s. No budget at all (closed with the first attempt) would
  // leave it to the repeat's own window, and the reason above would not be the budget's.
  assert.ok(seen.repeats[0].firstAttemptMs >= 2_000);
  assert.ok(seen.repeats[0].repeatMs < 2_800, `the repeat ran ${seen.repeats[0].repeatMs} ms`);
  assert.deepEqual(seen.reads, ['message-search', 'message-search', 'message-search']);
});

test('a first attempt that exhausts the vector budget is not repeated, whatever was written meanwhile', async (t) => {
  const stalled = hang(t);
  let embeds = 0;
  let flush;
  const { seen, flushMessage, search, outcomes } = await messageIndex(t, async (texts) => {
    if (!texts.some((text) => text.includes('sonata')) || embeds++ > 0) return;
    flush(); // a source write retires the snapshot as well
    await stalled; // and the vector read outlasts its 2 s
  });
  flush = flushMessage;

  const found = await search();

  assert.deepEqual(
    [found.meta.degradeReason, found.meta.effectiveMode],
    ['passage_vector_budget_exhausted', 'lexical'],
  );
  assert.deepEqual(outcomes(), [], 'the budget ran out: no second vector read');
  assert.equal(embeds, 1);
  assert.deepEqual(seen.reads, ['message-search', 'message-search']);
});

// Review of #7190 (codex61-terra): what "this attempt lost its vectors to a source write" may be
// concluded from, and what may be returned when the repeat is skipped.

test('a skipped repeat still answers from a read that started after the write', async (t) => {
  const { f, seen, outcomes } = await boundIndex(t);
  // "piano" is in every fixture title: the first attempt's lexical rows hold initial-1.
  let probes = 0;
  f.hooks.duringProbe = async () => {
    if (probes++ > 0) return;
    await sleep(2_000); // a slow first attempt, so that no repeat fits before the deadline below
    await f.store.deleteByAnchor('initial-1'); // the document is really removed while the attempt runs
  };

  const found = await f.store.searchWithMeta('piano', { mode: 'hybrid', limit: 50, deadlineAt: Date.now() + 7_000 });
  const anchors = found.items.map((item) => item.anchor);

  assert.deepEqual(outcomes(), ['skipped_budget']);
  assert.equal(found.meta.degraded, true);
  assert.ok(anchors.includes('initial-0'));
  assert.ok(!anchors.includes('initial-1'), 'the removed document is not served from the first attempt');
  assert.deepEqual(seen.reads, ['search', 'search']);
});

test('a quarantine that came and went during the search is not taken for a source write', async (t) => {
  const { f, seen, outcomes, byVector } = await boundIndex(t);
  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ > 0) return;
    f.quarantineFromAnotherConnection();
    reconcileGenerationInvalidations(f.store.getDb(), vectorGenerationTables('g0')); // a healthy writer recovers it
  };

  const found = await byVector();

  assert.equal(probes, 1, 'no second attempt');
  assert.equal(found.meta.degraded, true);
  assert.deepEqual(outcomes(), [], 'the epoch moved twice and nothing was written');
  assert.deepEqual(
    seen.degrades.map((record) => record.attempt ?? null),
    [null],
  );
  assert.deepEqual(seen.reads, ['search', 'search'], 'the epoch moved, so the answer is read again, lexically');
});

test('a provider error is not repeated because a write happened to land beside it', async (t) => {
  let embeds = 0;
  let write;
  const { f, seen, flush, outcomes } = await boundIndex(t, async (texts) => {
    if (!write || !texts.some((text) => text.includes('nocturne'))) return;
    embeds++;
    write();
    throw new Error('Embed API error: 503 Service Unavailable');
  });
  write = () => flush(`p-flushed-${embeds}`);

  const found = await f.store.searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt: Date.now() + 60_000 });

  assert.equal(embeds, 1, 'the model is not asked again');
  assert.deepEqual(
    [found.meta.degraded, found.meta.degradeReason],
    [true, 'passage_vector_search_error'],
    "the provider's failure stays the reason",
  );
  assert.deepEqual(outcomes(), []);
  assert.deepEqual(
    seen.degrades.map((record) => [record.errorCategory, record.attempt ?? null]),
    [['embed_api_http_503', null]],
    'and it is logged as what it was',
  );
  assert.deepEqual(seen.reads, ['search', 'search'], 'a source was written, so the answer is read again, lexically');
});

test('the repeat stays on the started worker when the other one was killed meanwhile', async (t) => {
  // Review probe: the pool's other process serves another search, that search is cancelled and its
  // process killed while ours is in its first attempt. Equal loads used to pick the dead one.
  const other = await boundIndex(t);
  const { f, seen, flush, outcomes, byVector } = await boundIndex(t);
  for (const list of Object.values(seen)) list.length = 0;
  const cancel = new AbortController();
  const stalled = hang(t);
  other.f.hooks.duringProbe = () => stalled;
  const cancelled = other.f.store
    .searchWithMeta('nocturne', { mode: 'hybrid', deadlineAt: Date.now() + 60_000, signal: cancel.signal })
    .catch((error) => error);
  while (seen.pids.length < 1) await sleep(5); // the other search occupies one read process

  let probes = 0;
  f.hooks.duringProbe = () => {
    if (probes++ > 0) return;
    cancel.abort(new Error('the other caller went away')); // kills the process serving it
    flush('p-flushed');
  };
  const found = await byVector();
  await cancelled;

  assert.deepEqual([found.meta.degraded, outcomes()], [false, ['recovered']]);
  assert.deepEqual(seen.reads, ['search', 'search', 'search'], "the other search's read, then ours twice");
  const [otherPid, firstPid, repeatPid] = seen.pids;
  assert.notEqual(firstPid, otherPid, 'our first attempt ran on the second process');
  assert.equal(repeatPid, firstPid, 'and so does the repeat: it is the one that is running');
});
