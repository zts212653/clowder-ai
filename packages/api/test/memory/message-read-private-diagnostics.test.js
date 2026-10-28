import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture(t, count, large = false) {
  const root = mkdtempSync(join(tmpdir(), 'private-message-read-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = store.getDb();
  db.prepare(
    "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES ('thread-neutral','thread','active','Neutral','','2026-01-01')",
  ).run();
  const put = db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at) VALUES ('thread-neutral',?,?,?,'2026-01-01T00:00:00Z')",
  );
  const body = `柚子${'甲'.repeat(large ? 6000 : 10)} secret-body-canary`;
  db.transaction(() => {
    for (let i = 0; i < count; i++) put.run(`msg-${i}`, body, i);
  })();
  return { store, body };
}

test('successful native CJK scan carries exact private counts without adding response fields', async (t) => {
  const { store, body } = await fixture(t, 33);
  const snapshots = [];
  const value = await store.searchMessagePassages('柚子', {
    mode: 'lexical',
    sort: 'time',
    visibleThreadIds: ['neutral'],
    onReadSnapshot: (s) => snapshots.push(s),
  });
  const final = snapshots.at(-1);
  assert.equal(final?.outcome, 'fulfilled');
  assert.equal(final.cjk?.outcome, 'fulfilled');
  assert.equal(final.cjk.bodyVisits, 33);
  assert.equal(final.cjk.bodyUtf16, body.length * 33);
  assert.equal(final.cjk.returnedRows, 33);
  assert.equal(final.cjk.complete, true);
  assert.ok(snapshots.length <= 10);
  assert.deepEqual(Object.keys(value).sort(), ['meta', 'passages']);
  assert.doesNotMatch(JSON.stringify(snapshots), /secret-body|柚子|SELECT|bindings/);
});

for (const reason of ['AbortError', 'TimeoutError'])
  test(`native CJK ${reason} retains lower-bound progress and kills the child`, async (t) => {
    const { store } = await fixture(t, 16000, true);
    const control = new AbortController();
    let observed;
    const snapshots = [];
    const started = performance.now();
    // Timer is a fail-safe, not the native checkpoint: cancellation must occur on an actual in-flight observation.
    const failSafe = setTimeout(() => control.abort(new DOMException('fixture fallback', reason)), 8000);
    try {
      await assert.rejects(
        store.searchMessagePassages('柚子', {
          mode: 'lexical',
          sort: 'time',
          visibleThreadIds: ['neutral'],
          signal: control.signal,
          onReadSnapshot(s) {
            snapshots.push(s);
            if (s.cjk?.outcome === 'running' && !control.signal.aborted) {
              observed = s;
              control.abort(new DOMException('fixture native cancellation', reason));
            }
          },
        }),
        (error) => {
          assert.equal(error, control.signal.reason);
          assert.ok(observed, 'must observe a real CJK callback checkpoint before cancel');
          assert.ok(error.memoryProcess.cjk.bodyVisits >= 256);
          assert.equal(error.memoryProcess.cjk.complete, false);
          assert.equal(error.memoryProcess.cjk.returnedRows, null);
          assert.equal(error.memoryProcess.cjk.outcome, 'running');
          assert.equal(error.memoryProcess.outcome, 'rejected');
          return true;
        },
      );
    } finally {
      clearTimeout(failSafe);
    }
    assert.ok(performance.now() - started < 8000);
    assert.ok(snapshots.length <= 10);
    let exited = false;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(observed.pid, 0);
      } catch {
        exited = true;
        break;
      }
      await pause(10);
    }
    assert.ok(exited, 'observed native child actually exited');
    assert.doesNotMatch(JSON.stringify(snapshots), /secret-body|柚子|SELECT|bindings/);
  });

test('a checkpoint-triggered native deadline retains its observed SQL and CJK progress', async (t) => {
  const { store } = await fixture(t, 16000, true);
  const control = new AbortController();
  let observed;
  await assert.rejects(
    store.searchMessagePassages('柚子', {
      mode: 'lexical',
      sort: 'time',
      visibleThreadIds: ['neutral'],
      signal: control.signal,
      // A fail-safe only: reaching it without the real checkpoint must fail the assertions below.
      deadlineAt: Date.now() + 8000,
      onReadSnapshot(snapshot) {
        if (snapshot.cjk?.outcome !== 'running' || control.signal.aborted) return;
        observed = snapshot;
        control.abort(new DOMException('controlled native deadline', 'TimeoutError'));
      },
    }),
    (error) => {
      assert.equal(error, control.signal.reason);
      assert.ok(observed, 'cancellation must follow an actual CJK checkpoint, not elapsed wall time');
      assert.ok(observed.cjk.bodyVisits >= 256);
      assert.equal(error.memoryProcess.pid, observed.pid);
      assert.equal(error.memoryProcess.lastObservedSql.event, 'sql-start');
      assert.ok(error.memoryProcess.lastObservedSql.caller.some((s) => s.includes('message-passage-lexical')));
      assert.deepEqual(error.memoryProcess.cjk, observed.cjk);
      assert.equal(error.memoryProcess.cjk.complete, false);
      assert.equal(error.memoryProcess.cjk.returnedRows, null);
      return true;
    },
  );
});

test('an absolute native deadline retains only observed progress and does not fabricate a finish', async (t) => {
  const { store } = await fixture(t, 16000, true);
  const words = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const snapshots = [];
  const deadlineAt = Date.now() + 700;
  await assert.rejects(
    store.searchMessagePassages(words.join(' '), {
      mode: 'lexical',
      sort: 'relevance',
      visibleThreadIds: ['neutral'],
      deadlineAt,
      onReadSnapshot: (s) => snapshots.push(s),
    }),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.memoryProcess.outcome, 'rejected');
      assert.equal(error.memoryProcess.lastObservedSql.event, 'sql-start');
      if (error.memoryProcess.cjk) {
        assert.equal(error.memoryProcess.cjk.complete, false);
        assert.equal(error.memoryProcess.cjk.returnedRows, null);
      } else assert.equal(error.memoryProcess.cjk, null, 'no checkpoint is unknown, not zero work');
      return true;
    },
  );
  assert.equal(snapshots.at(-1).outcome, 'rejected');
  assert.ok(snapshots.length <= 10);
});
