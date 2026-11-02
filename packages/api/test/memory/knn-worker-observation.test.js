import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

test(
  'file worker keeps completed KNN resources through hydration and start-only evidence through native cancellation',
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'knn-worker-observation-'));
    const store = new SqliteEvidenceStore(join(root, 'neutral.sqlite'));
    await store.initialize();
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    ensurePassageVectorTable(db, 4);
    db.prepare(
      "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('thread-neutral','thread','active','Neutral','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('thread-neutral','msg-0','body-canary','2026-01-01')",
    ).run();
    const insert = db.prepare('INSERT INTO passage_vectors(passage_key,embedding) VALUES(?,?)');
    const vector = new Float32Array([0.25, 0.25, 0.25, 0.25]);
    // Two MiB of neutral float values; large enough to observe actual native work before cancellation.
    db.transaction(() => {
      for (let i = 0; i < 131072; i++) insert.run(passageVectorKey('thread-neutral', `msg-${i}`), vector);
    })();
    let releaseNearDeadline;
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 4),
      passageVectorStore: new PassageVectorStore(db, 4),
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'neutral-fixture', modelRev: '1', dim: 4 }),
        embed: async () => {
          if (releaseNearDeadline) await releaseNearDeadline();
          return [vector];
        },
      },
    });
    const options = { mode: 'hybrid', sort: 'relevance', visibleThreadIds: ['neutral'] };
    const snapshots = [];
    const value = await store.searchMessagePassages('absentneutralterm', {
      ...options,
      onReadSnapshot: (s) => snapshots.push(s),
    });
    const final = snapshots.at(-1);
    assert.equal(final.nativeVectorRead?.event, 'sql-finish', 'successful hydration must retain the prior KNN witness');
    assert.equal(final.nativeVectorRead.native.requestedK, 2000);
    assert.equal(final.nativeVectorRead.native.dimensions, 4);
    assert.ok(Number.isFinite(final.nativeVectorRead.elapsedMs) && final.nativeVectorRead.elapsedMs >= 0);
    assert.ok(final.observedSqlMs >= final.nativeVectorRead.elapsedMs);
    assert.ok(final.nativeVectorRead.native.resourceDelta.userCpuUs >= 0);
    assert.notEqual(final.lastObservedSql.sqlFingerprint, final.nativeVectorRead.sqlFingerprint);
    assert.deepEqual(Object.keys(value).sort(), ['meta', 'passages']);
    assert.ok(snapshots.length <= 11);
    t.diagnostic(JSON.stringify({ kind: 'completed neutral KNN', observation: final.nativeVectorRead }));

    for (const reason of ['AbortError', 'TimeoutError']) {
      await store.searchMessagePassages('absentneutralterm', { ...options, mode: 'lexical' });
      const control = new AbortController();
      const deadlineAt = reason === 'TimeoutError' ? Date.now() + 1500 : undefined;
      if (deadlineAt)
        releaseNearDeadline = async () => {
          await pause(Math.max(0, deadlineAt - Date.now() - 15));
        };
      let observed;
      const failSafe = setTimeout(() => control.abort(new Error('fixture fail-safe')), 4000);
      try {
        await assert.rejects(
          store.searchMessagePassages('absentneutralterm', {
            ...options,
            deadlineAt,
            signal: control.signal,
            onReadSnapshot(s) {
              if (s.nativeVectorRead?.event === 'sql-start') {
                observed = s;
                if (reason === 'AbortError') control.abort(new DOMException('native fixture cancellation', reason));
              }
            },
          }),
          (error) => {
            assert.ok(observed, 'must observe actual native KNN start before cancellation/deadline');
            assert.equal(error.name, reason);
            if (reason === 'AbortError') assert.equal(error, control.signal.reason);
            const read = error.memoryProcess.nativeVectorRead;
            assert.equal(read.event, 'sql-start');
            assert.equal(Object.hasOwn(read, 'elapsedMs'), false, 'an interrupted call has no completed duration');
            assert.equal(read.native.requestedK, 2000);
            assert.equal(read.native.dimensions, 4);
            assert.ok(read.native.resourcesBefore.userCpuUs >= 0);
            assert.equal(read.native.resourcesAfter, undefined);
            assert.equal(
              read.native.resourceDelta,
              undefined,
              'a killed native call cannot report a completed resource delta',
            );
            return true;
          },
        );
      } finally {
        clearTimeout(failSafe);
        releaseNearDeadline = undefined;
      }
      let gone = false;
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(observed.pid, 0);
        } catch {
          gone = true;
          break;
        }
        await pause(10);
      }
      assert.ok(gone, 'native child has actually exited');
      t.diagnostic(
        JSON.stringify({
          kind: 'interrupted neutral KNN',
          reason,
          nativeStartObserved: true,
          childExited: gone,
          resourcesAfterKnown: false,
          resourceDeltaKnown: false,
          observation: observed.nativeVectorRead,
        }),
      );
    }
    assert.doesNotMatch(JSON.stringify(snapshots), /body-canary|neutral-fixture|SELECT|bindings/);
  },
);
