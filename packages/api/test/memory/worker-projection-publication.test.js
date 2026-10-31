import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'worker-projection-publication-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectors = new VectorStore(db, 4);
  const passages = new PassageVectorStore(db, 4);
  let embeddings = 0;
  store.setEmbedDeps({
    mode: 'on',
    vectorStore: vectors,
    passageVectorStore: passages,
    embedding: {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'controlled', modelRev: '1', dim: 4 }),
      embed: async (texts) => {
        embeddings++;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    },
  });
  await store.upsert([
    {
      anchor: 'alpha-doc',
      kind: 'feature',
      status: 'active',
      title: 'Alpha',
      summary: 'Semantic-only source.',
      sourceHash: 'source-A',
      updatedAt: '2026-10-01',
    },
    {
      anchor: 'beta-doc',
      kind: 'feature',
      status: 'active',
      title: 'Beta',
      summary: 'needle canonical lexical source.',
      sourceHash: 'source-C',
      updatedAt: '2026-10-01',
    },
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'Visible', updatedAt: '2026-10-01' },
    { anchor: 'thread-private', kind: 'thread', status: 'active', title: 'Private', updatedAt: '2026-10-01' },
  ]);
  vectors.upsert('alpha-doc', new Float32Array([1, 0, 0, 0]));
  vectors.upsert('beta-doc', new Float32Array([0, 1, 0, 0]));
  const insert = db.prepare(
    'INSERT INTO evidence_passages (doc_anchor, passage_id, content, created_at) VALUES (?, ?, ?, ?)',
  );
  insert.run('thread-visible', 'msg-semantic', 'Semantic-only old source.', '2026-10-01T01:00:00Z');
  insert.run('thread-visible', 'msg-lexical', 'needle retained source.', '2026-10-01T02:00:00Z');
  insert.run('thread-private', 'msg-hidden', 'needle hidden source.', '2026-10-01T00:00:00Z');
  for (const [thread, id, vector] of [
    ['thread-visible', 'msg-semantic', [1, 0, 0, 0]],
    ['thread-visible', 'msg-lexical', [0, 1, 0, 0]],
    ['thread-private', 'msg-hidden', [1, 0, 0, 0]],
  ])
    passages.upsert(passageVectorKey(thread, id), new Float32Array(vector));
  return { store, db, embeddingCount: () => embeddings };
}

// Test-local IPC boundary: the real RPC wrapper has already returned, serialized
// its vector/ready result and sent it to the real child. Retire before the parent
// can accept that child's final result. No sleeps, provider holds or fake worker.
function afterVectorSent(t, retire) {
  let sent = 0;
  let armed = false;
  const originalEmit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (event, message, ...args) {
    if (!armed && event === 'message' && message?.type === 'embedding' && message.method === 'embed') {
      armed = true;

      const originalSend = this.send;
      const rpcId = message.id;
      this.send = function (response, ...sendArgs) {
        const result = Reflect.apply(originalSend, this, [response, ...sendArgs]);
        if (sent === 0 && response.type === 'embedding-result' && response.id === rpcId) {
          assert.equal(response.ready, true);
          assert.equal(response.value.length, 1);
          assert.ok(response.value[0] instanceof Float32Array);
          sent++;
          retire();
        }
        return result;
      };
      t.after(() => {
        this.send = originalSend;
      });
    }
    return Reflect.apply(originalEmit, this, [event, message, ...args]);
  };
  t.after(() => {
    ChildProcess.prototype.emit = originalEmit;
  });
  return () => sent;
}

for (const consumer of ['document', 'message']) {
  for (const mode of ['semantic', 'hybrid']) {
    test(`${consumer} ${mode} retires worker results after successful vector RPC and reruns lexical`, async (t) => {
      const f = await fixture(t);
      const sent = afterVectorSent(t, () => {
        f.store.invalidateVectorProjection();
        f.db
          .prepare('UPDATE evidence_docs SET title=?, summary=?, source_hash=? WHERE anchor=?')
          .run('Gamma', 'Changed source after query RPC.', 'source-B', 'alpha-doc');
        f.db
          .prepare('UPDATE evidence_passages SET content=? WHERE doc_anchor=? AND passage_id=?')
          .run('Changed source after query RPC.', 'thread-visible', 'msg-semantic');
      });
      const result =
        consumer === 'document'
          ? await f.store.searchWithMeta('needle', { mode, scope: 'docs', limit: 1 })
          : await f.store.searchMessagePassages('needle', {
              mode,
              visibleThreadIds: ['visible'],
              sort: 'relevance',
              candidateLimit: 1,
              dateFrom: '2026-10-01',
            });
      assert.equal(sent(), 1, 'retirement must be after the actual successful vector RPC');
      assert.equal(f.embeddingCount(), 1, 'lexical recovery must not call the provider again');
      assert.equal(result.meta.degraded, true);
      assert.equal(result.meta.effectiveMode, 'lexical');
      if (consumer === 'document')
        assert.deepEqual(
          result.items.map((x) => x.anchor),
          ['beta-doc'],
        );
      else {
        assert.deepEqual(
          result.passages.map((x) => x.messageId),
          ['lexical'],
        );
        assert.equal(result.passages[0].match, 'lexical');
        assert.equal(result.meta.candidateLimit, 1);
        assert.equal(result.meta.sort, 'relevance');
        assert.equal(result.meta.sourceCoverage, 'unknown');
        assert.equal(result.meta.semanticCandidatesLimited, false);
      }
    });
  }
}

test('retired worker cannot reset the original deadline to obtain a lexical result', async (t) => {
  const f = await fixture(t);
  const deadlineAt = Date.now() + 10_000;
  const sent = afterVectorSent(t, () => {
    f.store.invalidateVectorProjection();
    t.mock.method(Date, 'now', () => deadlineAt + 1);
  });
  await assert.rejects(
    f.store.searchWithMeta('needle', { mode: 'semantic', scope: 'docs', deadlineAt }),
    (error) => error.name === 'TimeoutError',
  );
  assert.equal(sent(), 1);
  assert.equal(f.embeddingCount(), 1);
});
