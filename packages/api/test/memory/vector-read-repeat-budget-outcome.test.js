import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { test } from 'node:test';
import { onVectorReadRepeat } from '../../dist/domains/memory/vector-search-degrade-report.js';
import { cohortFixture, model } from './g0-ready-tail-fixture.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The optional-vector budget belongs outside the repeat. Its lexical read is still part of the
// same search: only that read's real result can complete the repeat's final outcome record.
for (const finalRead of ['succeeds', 'worker-exits', 'caller-cancels', 'deadline-passes']) {
  test(`message budget completion is recorded after the outer lexical read ${finalRead}`, async (t) => {
    const f = await cohortFixture(t);
    let enabled = false;
    let queryEncodes = 0;
    let release;
    const stalled = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const { lifecycle } = f.boot(async (texts) => {
      if (!enabled || !texts.some((text) => text.includes('sonata'))) return;
      if (++queryEncodes === 1) await sleep(1100);
      else await stalled;
    });
    assert.equal((await lifecycle.activate('on', { rebuildLegacyModel: model.modelId })).ok, true);
    await f.store.upsert([
      { anchor: 'thread-flushing', kind: 'thread', status: 'active', title: 'piano thread', updatedAt: '2026-11-16' },
    ]);
    const insert = f.store
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
    insert.run('thread-flushing', 'msg-1', 'piano message one', '2026-11-16');
    await lifecycle.catchUpAfterReady();
    for (let n = 0; n < 200 && !f.coverage().ready; n++) await sleep(25);
    assert.equal(f.coverage().ready, true);
    const caller = new AbortController();
    const reason = new Error('caller cancelled the outer lexical read');
    const options = {
      visibleThreadIds: ['flushing'],
      mode: 'hybrid',
      deadlineAt: Date.now() + 30_000,
      signal: caller.signal,
    };
    await f.store.searchMessagePassages('sonata', options);
    enabled = true;
    const events = [];
    const records = [];
    t.after(
      onVectorReadRepeat((record) => {
        records.push(record);
        events.push(`record:${record.outcome}`);
      }),
    );
    let reads = 0;
    const onJob = ({ kind, pid }) => {
      if (kind !== 'message-search') return;
      events.push(`read:${++reads}`);
      if (reads !== 3) return;
      if (finalRead === 'worker-exits') process.kill(pid, 'SIGKILL'); // this test's newly dispatched worker only
      if (finalRead === 'caller-cancels') caller.abort(reason);
      if (finalRead === 'deadline-passes') {
        // Model an API thread observing completion after its deadline; no 30-second busy wait.
        t.mock.method(Date, 'now', () => options.deadlineAt + 1);
      }
    };
    subscribe('cat-cafe.memory-process', onJob);
    t.after(() => unsubscribe('cat-cafe.memory-process', onJob));
    let flushed = false;
    const search = f.store.searchMessagePassages('sonata', {
      ...options,
      onReadSnapshot(snapshot) {
        if (flushed || snapshot.outcome !== 'fulfilled') return;
        flushed = true;
        insert.run('thread-flushing', 'msg-late', 'piano message late', '2026-11-16');
      },
    });
    if (finalRead === 'succeeds') {
      const result = await search;
      assert.deepEqual(
        [result.meta.degraded, result.meta.degradeReason, result.meta.effectiveMode],
        [true, 'passage_vector_budget_exhausted', 'lexical'],
      );
    } else if (finalRead === 'worker-exits') {
      await assert.rejects(search, /Memory process exited/);
    } else if (finalRead === 'caller-cancels') {
      await assert.rejects(search, (error) => error === reason);
    } else {
      await assert.rejects(search, (error) => error.code === 'deadline_exceeded' || error.name === 'TimeoutError');
    }
    assert.equal(caller.signal.aborted, finalRead === 'caller-cancels');
    assert.equal(queryEncodes, 2, 'the first read and one repeat share the vector budget');
    assert.equal(reads, 3, 'the outer budget owns the one final lexical read');
    const outcome =
      finalRead === 'succeeds'
        ? 'vector_budget_exhausted'
        : finalRead === 'worker-exits'
          ? 'lexical_failed'
          : 'cancelled';
    assert.deepEqual(
      records.map((record) => record.outcome),
      [outcome],
    );
    assert.deepEqual(events, ['read:1', 'read:2', 'read:3', `record:${outcome}`]);
  });
}
