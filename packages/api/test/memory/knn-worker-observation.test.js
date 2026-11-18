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
import { nativeKnnWitness } from '../helpers/native-knn-witness.js';

test(
  'file worker keeps completed KNN resources through hydration and start-only evidence through native cancellation',
  { timeout: 20000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'knn-worker-observation-'));
    const witness = nativeKnnWitness(t, root);
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
    const vectorStore = new VectorStore(db, 4);
    vectorStore.initMeta({ modelId: 'neutral-fixture', modelRev: '1', dim: 4 });
    db.prepare(
      "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('thread-neutral','thread','active','Neutral','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('thread-neutral','msg-0','body-canary','2026-01-01')",
    ).run();
    const insert = db.prepare('INSERT INTO passage_vectors(passage_key,embedding) VALUES(?,?)');
    const vector = new Float32Array([0.25, 0.25, 0.25, 0.25]);
    // Two MiB of neutral floats provide a real KNN workload for the completed-read witness.
    db.transaction(() => {
      for (let i = 0; i < 131072; i++) insert.run(passageVectorKey('thread-neutral', `msg-${i}`), vector);
    })();
    store.setEmbedDeps({
      mode: 'on',
      vectorStore,
      passageVectorStore: new PassageVectorStore(db, 4),
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'neutral-fixture', modelRev: '1', dim: 4 }),
        embed: async () => [vector],
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

    const admissionSnapshots = [];
    const budgetLimited = await store.searchMessagePassages('absentneutralterm', {
      ...options,
      deadlineAt: Date.now() + 1500,
      onReadSnapshot: (s) => admissionSnapshots.push(s),
    });
    assert.equal(budgetLimited.meta.effectiveMode, 'lexical');
    assert.equal(budgetLimited.meta.degraded, true);
    assert.equal(budgetLimited.meta.degradeReason, 'passage_vector_admission_budget_insufficient');
    assert.equal(budgetLimited.meta.semanticCandidatesLimited, false);
    assert.ok(admissionSnapshots.length > 0);
    assert.ok(admissionSnapshots.every((s) => s.nativeVectorRead === null));
    t.diagnostic(
      JSON.stringify({ kind: 'budget-limited hybrid', nativeStartObserved: false, meta: budgetLimited.meta }),
    );

    for (const reason of ['AbortError', 'TimeoutError']) {
      await store.searchMessagePassages('absentneutralterm', { ...options, mode: 'lexical' });
      const control = new AbortController();
      const arm = witness.arm(reason);
      const startedAt = Date.now();
      const deadlineAt = reason === 'TimeoutError' ? startedAt + 1500 : undefined;
      // Admission uses the original 15s caller budget. The unchanged 1.5s
      // deadline expires while SQLite is held inside its first-row UDF.
      const requestDeadlineAt = startedAt + 15_000;
      let observed;
      let enteredVerifiedAt;
      let witnessFailure;
      const beforeDeadline = (time) => deadlineAt === undefined || time < deadlineAt;
      const interrupt = setInterval(() => {
        if (!observed || !witness.entered(arm)) return;
        try {
          witness.assertEntered(arm, observed);
          const verifiedAt = Date.now();
          if (!beforeDeadline(verifiedAt)) return;
          enteredVerifiedAt = verifiedAt;
          clearInterval(interrupt);
          if (reason === 'AbortError') control.abort(new DOMException('native fixture cancellation', reason));
        } catch (error) {
          witnessFailure = error;
          clearInterval(interrupt);
          control.abort(error);
        }
      }, 1);
      const failSafe = setTimeout(() => control.abort(new Error('fixture fail-safe')), 4000);
      try {
        await assert.rejects(
          store.searchMessagePassages('absentneutralterm', {
            ...options,
            deadlineAt,
            requestDeadlineAt,
            signal: control.signal,
            onReadSnapshot(s) {
              if (s.nativeVectorRead?.event === 'sql-start') {
                observed = s;
              }
            },
          }),
          (error) => {
            if (witnessFailure) throw witnessFailure;
            assert.ok(enteredVerifiedAt !== undefined, 'SQLite witness must be verified before cancellation/deadline');
            if (deadlineAt !== undefined) assert.ok(enteredVerifiedAt < deadlineAt);
            assert.ok(observed, 'must retain the native SQL call-boundary observation');
            witness.assertEntered(arm, observed);
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
        clearInterval(interrupt);
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
          sqliteCallEntered: true,
          enteredVerifiedAt,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          childExited: gone,
          resourcesAfterKnown: false,
          resourceDeltaKnown: false,
          observation: observed.nativeVectorRead,
        }),
      );
    }
    assert.doesNotMatch(JSON.stringify(snapshots), /body-canary|neutral-fixture|SELECT|bindings/);
    assert.doesNotMatch(JSON.stringify(admissionSnapshots), /body-canary|neutral-fixture|SELECT|bindings/);
  },
);
