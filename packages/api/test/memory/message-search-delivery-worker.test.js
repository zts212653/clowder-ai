import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { messageSearchResponseSchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import * as sqliteVec from 'sqlite-vec';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';
import { evidenceRoutes } from '../../dist/routes/evidence.js';

// Actual service -> file-backed worker/IPC -> SQLite/controlled vector RPC ->
// canonical/final admission -> HTTP/shared schema. No production data or model.
test('ordinary cat and human searches consume the same real worker queue for both sorts without judging', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'search-delivery-worker-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert(
    ['visible', 'private'].map((id) => ({
      anchor: `thread-${id}`,
      kind: 'thread',
      status: 'active',
      title: 'Isolated delivery',
      updatedAt: '2026-11-01',
    })),
  );
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectorStore = new VectorStore(db, 4);
  vectorStore.initMeta({ modelId: 'controlled-delivery', modelRev: '1', dim: 4 });
  const vectors = new PassageVectorStore(db, 4);
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)');
  const messages = new Map();
  for (const [id, threadId, content, date, vector] of [
    ['semantic', 'visible', '新伙伴的称呼在这里敲定。', '2026-01-02', [1, 0, 0, 0]],
    ['retelling', 'visible', 'Cedar 取名 的原始讨论。', '2026-06-01', [0.9, 0.1, 0, 0]],
    ['noise', 'visible', '另一个项目的取名规则。', '2026-01-01', [0, 1, 0, 0]],
    ['private', 'private', 'Cedar 取名 私有来源。', '2025-01-01', [1, 0, 0, 0]],
  ]) {
    insert.run(`thread-${threadId}`, `msg-${id}`, content, date);
    vectors.upsert(passageVectorKey(`thread-${threadId}`, `msg-${id}`), new Float32Array(vector));
    messages.set(id, {
      id,
      threadId,
      userId: threadId === 'visible' ? 'owner' : 'other',
      catId: null,
      content,
      timestamp: Date.parse(date),
    });
  }
  store.setEmbedDeps({
    mode: 'on',
    vectorStore,
    passageVectorStore: vectors,
    embedding: {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'controlled-delivery', modelRev: '1', dim: 4 }),
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    },
  });
  const thread = { id: 'visible', createdBy: 'owner', title: 'Isolated delivery' };
  const snapshots = [],
    selectors = [];
  let judges = 0;
  const service = new MessageSearchService({
    qualifier: {
      qualify() {
        judges++;
        throw new Error('Generative qualification is retired');
      },
    },
    evidenceStore: {
      readMessagePassageState: (candidate) => store.readMessagePassageState(candidate),
      searchMessagePassages: (query, options) => {
        selectors.push(options.candidateOrder);
        return store.searchMessagePassages(query, {
          ...options,
          onReadSnapshot: (snapshot) => {
            snapshots.push(snapshot);
            options.onReadSnapshot?.(snapshot);
          },
        });
      },
    },
    messageStore: { getById: (id) => messages.get(id) },
    threadStore: { get: (id) => (id === 'visible' ? thread : null), list: () => [thread] },
  });
  await app.register(evidenceRoutes, { evidenceStore: store, messageSearchService: service });
  for (const sort of ['time', 'relevance']) {
    const input = { query: 'Cedar 取名', sort, mode: 'hybrid', limit: 3 };
    const cat = await service.search(input, { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } });
    const response = await app.inject({
      url: `/api/evidence/search?resultUnit=message&q=Cedar%20%E5%8F%96%E5%90%8D&messageSort=${sort}&limit=3`,
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    const human = messageSearchResponseSchema.parse(response.json());
    assert.deepEqual(cat.results, human.results);
    assert.deepEqual(cat.meta, human.meta);
    assert.equal(cat.meta.sort, sort);
    assert.equal(cat.meta.resultKind, 'sources');
    assert.equal(cat.meta.qualification, undefined);
    assert.ok(cat.results.some((row) => row.messageId === 'semantic'));
    assert.ok(cat.results.some((row) => row.messageId === 'retelling'));
    assert.ok(cat.results.every((row) => row.threadId === 'visible'));
    assert.equal(JSON.stringify(cat).length <= 24000, true);
    if (sort === 'time')
      assert.deepEqual(
        cat.results.map((row) => row.messageId),
        ['noise', 'semantic', 'retelling'],
      );
  }
  assert.equal(judges, 0);
  assert.deepEqual(selectors, Array(4).fill('relevance'));
  assert.ok(
    snapshots.some(
      (snapshot) => snapshot.kind === 'message-search' && snapshot.outcome === 'fulfilled' && snapshot.pid > 0,
    ),
  );
});
