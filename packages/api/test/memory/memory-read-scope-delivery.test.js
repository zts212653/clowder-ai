import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import * as vec from 'sqlite-vec';
import { runMemoryRead } from '../../dist/domains/memory/MemoryProcess.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function until(predicate, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!predicate() && performance.now() < deadline) await pause(5);
  return predicate();
}

test(
  'a real completed scope arrives before a delayed result and survives cancellation without leaking to another execution',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'memory-scope-delivery-'));
    const priorOptions = process.env.NODE_OPTIONS;
    const priorBarrier = process.env.CAT_CAFE_TEST_MEMORY_RESULT_BARRIER;
    const hook = new URL('../helpers/memory-result-barrier.mjs', import.meta.url).href;
    process.env.NODE_OPTIONS = `${priorOptions ?? ''} --import=${hook}`;
    process.env.CAT_CAFE_TEST_MEMORY_RESULT_BARRIER = root;
    const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
    const control = new AbortController();
    let pending;
    let workerPid = 0;
    t.after(async () => {
      control.abort(new Error('fixture cleanup'));
      await pending;
      if (workerPid)
        assert.ok(
          await until(() => {
            try {
              process.kill(workerPid, 0);
              return false;
            } catch {
              return true;
            }
          }),
          'fixture worker exited',
        );
      if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = priorOptions;
      if (priorBarrier === undefined) delete process.env.CAT_CAFE_TEST_MEMORY_RESULT_BARRIER;
      else process.env.CAT_CAFE_TEST_MEMORY_RESULT_BARRIER = priorBarrier;
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await store.initialize();
    await store.upsert([
      { anchor: 'thread-fixture', kind: 'thread', status: 'active', title: 'memory', updatedAt: '2026-01-01' },
    ]);
    const db = store.getDb();
    db.prepare(`INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at)
      VALUES ('thread-fixture','msg-1','memory scope witness',1,'2026-01-01')`).run();
    vec.load(db);
    ensureVectorTable(db, 2);
    ensurePassageVectorTable(db, 2);
    const model = { modelId: 'fixture', modelRev: '1', dim: 2 };
    new VectorStore(db, 2).initMeta(model);
    new PassageVectorStore(db, 2).upsert(passageVectorKey('thread-fixture', 'msg-1'), new Float32Array([1, 0]));
    const embedding = {
      async load() {},
      async reprobeIfNeeded() {},
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0]));
      },
      isReady: () => true,
      getModelInfo: () => model,
      dispose() {},
    };
    const job = {
      kind: 'message-search',
      dbPath: join(root, 'evidence.sqlite'),
      query: 'memory',
      flags: {},
      options: { mode: 'hybrid', visibleThreadIds: ['fixture'], candidateLimit: 2 },
      embedding: { ready: true, model, passages: true, mode: 'on' },
    };
    writeFileSync(join(root, 'hold'), 'hold the actual final result');
    const snapshots = [];
    let settled = false;
    const reason = new DOMException('cancel after the scope ended', 'AbortError');
    pending = runMemoryRead(job, {
      embedding,
      signal: control.signal,
      deadlineAt: Date.now() + 8000,
      onReadSnapshot: (s) => snapshots.push(s),
    })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    assert.ok(
      await until(() => existsSync(join(root, 'result-ready.json'))),
      'the real worker must reach its delayed result',
    );
    const ready = JSON.parse(readFileSync(join(root, 'result-ready.json'), 'utf8'));
    workerPid = ready.pid;
    assert.equal(ready.error, undefined);
    assert.equal(ready.readWindow.cleanup, true, 'actual SQLite scope ended before the result barrier');
    assert.ok(ready.readWindow.preload);
    assert.ok(
      await until(() => snapshots.some((s) => s.readWindow?.cleanup === true), 1000),
      'the completed scope must reach its parent before the held result',
    );
    assert.equal(settled, false, 'the observation is independent of final job completion');
    const ended = snapshots.find((s) => s.readWindow?.cleanup === true);
    assert.equal(ended.outcome, 'pending');
    assert.deepEqual(ended.readWindow, ready.readWindow);
    assert.ok(
      await until(() => snapshots.some((s) => s.timings?.resultPrepared), 1000),
      'result preparation is observed while its payload is still held',
    );
    control.abort(reason);
    const stopped = await pending;
    assert.equal(stopped.error, reason);
    assert.equal(stopped.error.memoryProcess.executionId, ended.executionId);
    assert.deepEqual(stopped.error.memoryProcess.readWindow, ended.readWindow);
    assert.ok(
      await until(() => {
        try {
          process.kill(ready.pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
      'cancelled worker exited',
    );
    const timing = stopped.error.memoryProcess.timings;
    assert.ok(timing, 'the same attempt keeps its observed lifecycle timing');
    assert.equal(timing.parentClock, 'monotonic-since-submit');
    assert.equal(timing.workerClock, 'monotonic-since-run');
    assert.ok(timing.vectorsStarted.parentReceivedMs <= timing.scopeEndObservation.parentReceivedMs);
    assert.ok(timing.scopeEndObservation.parentReceivedMs <= timing.cancelRequestedMs);
    assert.ok(timing.scopeEndObservation.workerElapsedMs <= timing.resultPrepared.workerElapsedMs);
    assert.ok(timing.cancelRequestedMs <= timing.settledMs);
    assert.equal(timing.resultReceivedMs, null, 'held result was never delivered');
    const query = timing.embeddingCalls.find((call) => call.method === 'embed');
    assert.ok(query && query.parentSettledMs >= query.parentReceivedMs);
    assert.equal(query.outcome, 'fulfilled');
    assert.ok(query.parentSettledMs <= timing.scopeEndObservation.parentReceivedMs);
    const lexical = [];
    const result = await runMemoryRead(
      { ...job, options: { ...job.options, mode: 'lexical' } },
      {
        embedding,
        onReadSnapshot: (s) => lexical.push(s),
        deadlineAt: Date.now() + 5000,
      },
    );
    assert.equal(result.passages[0].messageId, '1');
    const next = lexical.at(-1);
    assert.notEqual(next.executionId, ended.executionId);
    assert.equal(next.readWindow.preload, null);
    assert.equal(next.timings.scopeEndObservation, null);
    assert.equal(next.timings.vectorsStarted, null);
    assert.deepEqual(next.timings.embeddingCalls, []);
    assert.ok(next.timings.resultPrepared && next.timings.resultReceivedMs !== null);
    assert.equal(next.timings.cancelRequestedMs, null);
    const failureFrames = [];
    const degrades = [];
    const fallback = await runMemoryRead(job, {
      embedding: {
        ...embedding,
        embed: async () => {
          throw new Error('controlled provider failure');
        },
      },
      onReadSnapshot: (s) => failureFrames.push(s),
      onVectorDegrade: (d) => degrades.push(d),
      deadlineAt: Date.now() + 5000,
    });
    assert.equal(fallback.meta.effectiveMode, 'lexical');
    assert.equal(fallback.meta.degraded, true);
    assert.equal(fallback.passages[0].messageId, '1');
    assert.ok(degrades.length > 0);
    const failedBridge = failureFrames.at(-1);
    assert.equal(failedBridge.timings.embeddingCalls.find((call) => call.method === 'embed').outcome, 'rejected');
    assert.equal(failedBridge.timings.scopeEndObservation, null);
    assert.equal(failedBridge.readWindow.preload, null);
  },
);
