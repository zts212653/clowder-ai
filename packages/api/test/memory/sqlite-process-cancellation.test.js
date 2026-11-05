import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('abort kills active native SQL and queued cancellation does not start another scan', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-cancel-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  // FTS matches every row; each source body is large enough that this is a real
  // SQLite scan, not an artificial sleep in a mock service.
  const db = store.getDb();
  const insert = db.prepare(
    `INSERT INTO evidence_docs (anchor,kind,status,title,summary,updated_at) VALUES (?,'feature','active','common',?,'2026-01-01')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) insert.run(`F${i}`, 'common filler '.repeat(1000));
  })();
  const controller = new AbortController();
  const events = channel('cat-cafe.memory-process');
  let pid = 0;
  let cancelAt = 0;
  const subscriber = (message) => {
    const event = message;
    if (event.kind !== 'search' || pid) return;
    pid = event.pid;
    setTimeout(() => {
      cancelAt = performance.now();
      controller.abort(new DOMException('client left', 'AbortError'));
    }, 25);
  };
  events.subscribe(subscriber);
  t.after(() => events.unsubscribe(subscriber));
  await assert.rejects(store.search('common', { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(pid > 0);
  assert.ok(performance.now() - cancelAt < 250, 'cancellation waited for native SQL to finish');
  let exited = false;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
    await pause(10);
  }
  assert.ok(exited, 'canceled SQLite child must exit, not continue burning CPU');
  const start = performance.now();
  await assert.rejects(store.search('common', { deadlineAt: Date.now() - 1 }), { name: 'TimeoutError' });
  assert.ok(performance.now() - start < 100);
  assert.deepEqual(await store.search('definitely-absent', { deadlineAt: Date.now() + 10_000 }), []);
});

test('a canceled message reader retains its own bounded pre-return native witness', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'message-read-witness-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = store.getDb();
  db.prepare(
    "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES ('thread-fixture','thread','active','fixture','','2026-01-01')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at) VALUES ('thread-fixture',?,?,?,'2026-01-01T00:00:00Z')",
  );
  const words = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  db.transaction(() => {
    for (let i = 0; i < 10000; i++)
      insert.run(`msg-${i}`, `${words.at(-1)}${'甲'.repeat(1000)} private-body-canary`, i);
  })();
  const controller = new AbortController();
  const events = channel('cat-cafe.memory-process');
  let pid = 0;
  let cancelAt = 0;
  let observed;
  const subscriber = (event) => {
    if (event.kind !== 'message-search' || pid) return;
    pid = event.pid;
  };
  events.subscribe(subscriber);
  t.after(() => events.unsubscribe(subscriber));
  await assert.rejects(
    store.searchMessagePassages(words.join(' '), {
      mode: 'lexical',
      sort: 'relevance',
      visibleThreadIds: ['fixture'],
      signal: controller.signal,
      // A fail-safe, never the evidence that native SQL has actually begun.
      deadlineAt: Date.now() + 8000,
      onReadSnapshot(snapshot) {
        if (controller.signal.aborted || snapshot.cjk?.outcome !== 'running') return;
        observed = snapshot;
        cancelAt = performance.now();
        controller.abort(new DOMException('controlled deadline', 'TimeoutError'));
      },
    }),
    (error) => {
      assert.equal(error, controller.signal.reason);
      assert.ok(observed, 'cancel only after an actual pre-return CJK checkpoint');
      assert.ok(observed.cjk.bodyVisits >= 256);
      const evidence = error.memoryProcess;
      assert.ok(evidence, 'a killed native message reader must retain its request-scoped progress');
      assert.equal(evidence.kind, 'message-search');
      assert.equal(evidence.pid, pid);
      assert.equal(evidence.pid, observed.pid);
      assert.equal(evidence.executionId, observed.executionId);
      assert.ok(evidence.queueMs >= 0 && evidence.elapsedMs >= evidence.queueMs);
      assert.equal(evidence.lastObservedSql.event, 'sql-start');
      assert.match(evidence.lastObservedSql?.sqlFingerprint ?? '', /^[a-f0-9]{64}$/);
      assert.ok(evidence.lastObservedSql.caller.some((line) => line.includes('message-passage-lexical')));
      assert.deepEqual(evidence.lastObservedSql, observed.lastObservedSql);
      assert.deepEqual(evidence.cjk, observed.cjk);
      assert.equal(evidence.cjk.complete, false);
      assert.equal(evidence.cjk.returnedRows, null);
      assert.doesNotMatch(JSON.stringify(evidence), /private-body|SELECT|FROM evidence_passages/);
      return true;
    },
  );
  assert.ok(performance.now() - cancelAt < 250, 'diagnostics must not delay native cancellation');
  let exited = false;
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
    await pause(10);
  }
  assert.ok(exited, 'the observed message reader must actually exit');
});

test('canceling at worker ready does not invent an unobserved SQL witness', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'message-before-sql-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const events = channel('cat-cafe.memory-process');
  let pid = 0;
  const subscriber = (event) => {
    if (event.kind !== 'message-search' || pid) return;
    pid = event.pid;
    controller.abort(new DOMException('left before SQL observation', 'AbortError'));
  };
  events.subscribe(subscriber);
  t.after(() => events.unsubscribe(subscriber));
  await assert.rejects(
    store.searchMessagePassages('private-query-canary', {
      mode: 'lexical',
      visibleThreadIds: ['fixture'],
      signal: controller.signal,
      deadlineAt: Date.now() + 8000,
    }),
    (error) => {
      assert.equal(error, controller.signal.reason);
      assert.ok(pid > 0, 'the worker really reported ready');
      assert.equal(error.memoryProcess.pid, pid);
      assert.equal(error.memoryProcess.outcome, 'rejected');
      assert.equal(error.memoryProcess.lastObservedSql, undefined);
      assert.equal(error.memoryProcess.sqlObservations, 0);
      assert.equal(error.memoryProcess.observedSqlMs, 0);
      assert.equal(error.memoryProcess.cjk, null);
      assert.doesNotMatch(JSON.stringify(error.memoryProcess), /private-query|SELECT|bindings/);
      return true;
    },
  );
});
