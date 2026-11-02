import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import pino from 'pino';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'private-request-'));
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
  db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at) VALUES ('thread-neutral','msg-one','柚子秘密正文',0,'2026-01-01T00:00:00Z')",
  ).run();
  return store;
}

test('HTTP late canonical failure retains successful real worker origin and bounded operation evidence', async (t) => {
  const store = await fixture(t);
  let logged = '';
  const app = Fastify({
    logger: pino(
      { level: 'info' },
      new Writable({
        write(c, _e, next) {
          logged += c;
          next();
        },
      }),
    ),
  });
  t.after(() => app.close());
  const original = new DOMException('controlled deadline', 'TimeoutError');
  const service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async () => {
      assert.fail('fixture must not invoke a model');
    }),
    evidenceStore: store,
    threadStore: { list: () => [{ id: 'neutral', createdBy: 'private-owner' }] },
    messageStore: {
      getById: async () => {
        await new Promise((r) => setImmediate(r));
        throw original;
      },
    },
  });
  app.get('/search', (_r, reply) =>
    executeMessageSearch(
      service,
      { query: '柚子', mode: 'lexical', sort: 'time' },
      { userId: 'private-owner', viewer: { type: 'user' } },
      reply,
    ),
  );
  const res = await app.inject('/search');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), {
    error: 'Message search unavailable',
    degraded: true,
    degradeReason: 'message_search_timeout',
  });
  const lines = logged
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  const evidence = lines.find((x) => x.msg === 'Message search unavailable').err.messageSearchExecution;
  assert.equal(evidence.phase, 'canonical-projection');
  assert.equal(evidence.workerReads.length, 1);
  assert.equal(evidence.workerReads[0].outcome, 'fulfilled');
  assert.equal(evidence.workerReads[0].cjk.returnedRows, 1);
  assert.equal(evidence.canonical.waves.started, 1);
  assert.equal(evidence.canonical.operations.source.started, 1);
  assert.equal(evidence.canonical.operations.source.rejected, 1);
  assert.equal(evidence.canonical.operations.access.started, 0);
  assert.ok(evidence.canonical.operations.source.elapsedMs > 0);
  assert.doesNotMatch(JSON.stringify(evidence), /private-owner|秘密|柚子|SELECT/);
  assert.ok(lines.filter((x) => x.msg === 'Message search execution').length <= 32);
});

test('throwing diagnostic trace sinks cannot replace successful search or original failure', async () => {
  const reason = new DOMException('original', 'TimeoutError');
  const service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async () => {
      assert.fail('fixture must not invoke a model');
    }),
    threadStore: { list: () => [] },
    messageStore: {},
    evidenceStore: {
      searchMessagePassages: () => ({ passages: [], meta: { candidateLimit: 2000, effectiveMode: 'lexical' } }),
      readMessagePassageState: () => ({ current: true }),
    },
  });
  const input = { query: 'neutral', mode: 'lexical' };
  const principal = { userId: 'owner', viewer: { type: 'user' } };
  const result = await service.search(input, principal, {
    onTrace() {
      throw reason;
    },
  });
  assert.deepEqual(result.results, []);
});
