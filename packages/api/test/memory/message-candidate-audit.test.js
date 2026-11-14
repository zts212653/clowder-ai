import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import pino from 'pino';
import * as sqliteVec from 'sqlite-vec';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import {
  MessageCandidateAudit,
  ownerCandidateAuditRequest,
} from '../../dist/domains/memory/message-candidate-audit.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

const auditRequest = { id: '11111111-2222-4333-8444-555555555555', key: 'a7'.repeat(32) };
const token = (id) =>
  createHmac('sha256', auditRequest.key)
    .update(JSON.stringify(['message-candidate-audit', 1, 'message', 'thread-visible', `msg-${id}`]))
    .digest('hex')
    .slice(0, 32);

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-audit-'));
  const store = new SqliteEvidenceStore(join(root, 'neutral.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([
    { anchor: 'thread-visible', kind: 'thread', status: 'active', title: 'Neutral', updatedAt: '2026-01-01' },
  ]);
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectorStore = new VectorStore(db, 4);
  vectorStore.initMeta({ modelId: 'neutral-local-control', modelRev: '1', dim: 4 });
  const vectors = new PassageVectorStore(db, 4);
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)');
  const rows = [
    ['a', 'needle neutral material', [0, 1, 0, 0]],
    ['b', 'needle neutral material', [1, 0, 0, 0]],
    ['c', 'needle neutral material', [0.98, 0.05, 0, 0]],
    ['target', 'separate original material', [0.9, 0.2, 0, 0]],
  ];
  for (const [id, body, vector] of rows) {
    insert.run('thread-visible', `msg-${id}`, body, '2026-01-01T00:00:00Z');
    vectors.upsert(passageVectorKey('thread-visible', `msg-${id}`), new Float32Array(vector));
  }
  let calls = 0;
  store.setEmbedDeps({
    mode: 'on',
    vectorStore,
    passageVectorStore: vectors,
    embedding: {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'neutral-local-control', modelRev: '1', dim: 4 }),
      embed: async (texts) => {
        calls++;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    },
  });
  return { store, rows, calls: () => calls };
}

test('actual SQLite/NN worker distinguishes entering the native pool from falling outside the fused pool', async (t) => {
  const f = await fixture(t);
  const snapshots = [];
  const options = {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    sort: 'relevance',
    candidateOrder: 'relevance',
    candidateLimit: 3,
  };
  const plain = await f.store.searchMessagePassages('needle', options);
  const observed = await f.store.searchMessagePassages('needle', {
    ...options,
    candidateAudit: auditRequest,
    onReadSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  assert.deepEqual(observed, plain, 'observation must not change the actual result or metadata');
  assert.deepEqual(
    observed.passages.map((row) => row.messageId),
    ['b', 'c', 'a'],
  );
  assert.equal(f.calls(), 2, 'one controlled local embedding per existing retrieval, no additional inference');
  const final = snapshots.at(-1);
  assert.equal(final.outcome, 'fulfilled');
  assert.ok(final.pid > 0, 'requires the real file-worker IPC path');
  assert.ok(final.candidateAudit, 'a successful search needs bounded stage evidence');
  assert.equal(
    snapshots.filter((snapshot) => snapshot.candidateAudit).length,
    1,
    'one complete table per actual reader',
  );
  // tuple = fingerprint, lexical rank, raw NN rank, NN RRF input rank, fused rank, final reader rank.
  const original = final.candidateAudit.rows.find((row) => row[0] === token('target'));
  assert.deepEqual(original?.slice(1), [0, 3, 3, 4, 0]);
  t.diagnostic(
    JSON.stringify({
      nativeRank: original[2],
      fusedRank: original[4],
      readerRank: original[5],
      bytes: Buffer.byteLength(JSON.stringify(final.candidateAudit)),
    }),
  );
  assert.doesNotMatch(JSON.stringify(final.candidateAudit), /thread-visible|msg-target|needle|original material/);
  assert.ok(!JSON.stringify(final.candidateAudit).includes(auditRequest.key));
  const summary = ({
    executionId,
    pid,
    queueMs,
    elapsedMs,
    observedSqlMs,
    lastObservedSql,
    nativeVectorRead,
    candidateAudit,
    ...value
  }) => value;
  const plainSnapshots = [];
  await f.store.searchMessagePassages('needle', {
    ...options,
    onReadSnapshot: (snapshot) => plainSnapshots.push(snapshot),
  });
  assert.deepEqual(summary(final), summary(plainSnapshots.at(-1)), 'audit adds no SQL reads or provider work');
});

test('ordinary host diagnostics separate owner rejection, admission and final revision without leaking rejected identity', async (t) => {
  const previousSalt = process.env.TELEMETRY_HMAC_SALT;
  process.env.TELEMETRY_HMAC_SALT = 'neutral-fixture-salt-'.repeat(3);
  t.after(() => {
    if (previousSalt === undefined) delete process.env.TELEMETRY_HMAC_SALT;
    else process.env.TELEMETRY_HMAC_SALT = previousSalt;
  });
  const f = await fixture(t);
  const thread = { id: 'visible', createdBy: 'owner', title: 'Neutral' };
  const bodies = new Map(f.rows.map(([id, content]) => [id, content]));
  const traces = [];
  const service = new MessageSearchService({
    evidenceStore: f.store,
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: (id) => ({
        id,
        threadId: 'visible',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content: id === 'b' ? 'changed canonical material' : bodies.get(id),
        timestamp: 1000,
      }),
    },
  });
  const result = await service.search(
    { query: 'needle', mode: 'hybrid', sort: 'time', limit: 1 },
    { userId: 'owner', viewer: { type: 'user' } },
    { onTrace: (trace) => traces.push(trace) },
  );
  assert.equal(result.results.length, 1);
  const audit = traces.find((trace) => trace.phase === 'candidate-audit');
  assert.ok(audit, 'the existing private trace needs one final bounded candidate audit');
  assert.equal(audit.searchId, result.searchId);
  assert.ok(audit.candidateAudit.canonical.some((row) => row[2] === 'owner_projection_rejected'));
  assert.ok(audit.candidateAudit.canonical.some((row) => row[2] === 'final_admitted' && /^[a-f0-9]{64}$/.test(row[3])));
  assert.doesNotMatch(
    JSON.stringify(traces),
    /msg-b|thread-visible|changed canonical|neutral material|neutral-fixture-salt/,
  );
  const request = ownerCandidateAuditRequest(result.searchId, 'owner');
  const rejected = createHmac('sha256', request.key)
    .update(JSON.stringify(['message-candidate-audit', 1, 'message', 'thread-visible', 'msg-b']))
    .digest('hex')
    .slice(0, 32);
  assert.ok(
    !JSON.stringify(traces).includes(rejected),
    'host rejection scrubs the earlier lexical and vector observations',
  );
  assert.equal(traces.filter((trace) => trace.phase === 'candidate-audit').length, 1);
  assert.ok(traces.filter((trace) => trace.phase !== 'candidate-audit').every((trace) => !('candidateAudit' in trace)));
  const comparison = MessageCandidateAudit.create(request, 1);
  comparison.order(1, [{ docAnchor: 'thread-visible', passageId: `msg-${result.results[0].messageId}` }]);
  assert.ok(
    audit.candidateAudit.rows.some((row) => row[0] === comparison.snapshot().rows[0][0]),
    'the public product API reproduces the actual event domain for an admitted source',
  );
  const reads = new Map();
  const revocationTraces = [];
  const revokedService = new MessageSearchService({
    evidenceStore: f.store,
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: (id) => {
        const count = (reads.get(id) ?? 0) + 1;
        reads.set(id, count);
        return id === 'b' && count > 1
          ? null
          : { id, threadId: 'visible', userId: 'owner', content: bodies.get(id), timestamp: 1000 };
      },
    },
  });
  const revoked = await revokedService.search(
    { query: 'needle', mode: 'hybrid', sort: 'time', limit: 1 },
    { userId: 'owner', viewer: { type: 'user' } },
    { onTrace: (trace) => revocationTraces.push(trace) },
  );
  assert.ok(reads.get('b') >= 2, 'the real host projector must perform final revalidation');
  const revocationRequest = ownerCandidateAuditRequest(revoked.searchId, 'owner');
  const revokedFingerprint = createHmac('sha256', revocationRequest.key)
    .update(JSON.stringify(['message-candidate-audit', 1, 'message', 'thread-visible', 'msg-b']))
    .digest('hex')
    .slice(0, 32);
  assert.ok(
    !JSON.stringify(revocationTraces).includes(revokedFingerprint),
    'a source lost after initial projection is scrubbed from all earlier rows',
  );
  assert.ok(!revoked.results.some((row) => row.messageId === 'b'));
  let logged = '';
  const log = new Writable({
    write(chunk, _encoding, next) {
      logged += chunk.toString();
      next();
    },
  });
  const app = Fastify({ logger: pino({ level: 'info' }, log) });
  t.after(() => app.close());
  app.get('/fixture-search', (_request, reply) =>
    executeMessageSearch(
      service,
      { query: 'needle', mode: 'hybrid', sort: 'time', limit: 1 },
      { userId: 'owner', viewer: { type: 'user' } },
      reply,
    ),
  );
  const http = await app.inject('/fixture-search');
  assert.equal(http.statusCode, 200);
  const event = logged
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((line) => line.messageSearchTrace?.phase === 'candidate-audit');
  assert.ok(event?.reqId, 'the actual HTTP logger associates the event with request id');
  assert.equal(event.messageSearchTrace.searchId, http.json().searchId);
  assert.match(event.messageSearchTrace.readerExecutionId, /^[a-f0-9-]{36}$/);
  assert.ok(!('candidateAudit' in http.json()));
  assert.doesNotMatch(logged, /thread-visible|msg-b|neutral-fixture-salt|changed canonical|neutral material/);
});

test('actual native hits excluded by index suppression, hidden thread and source identity are scrubbed', async (t) => {
  const f = await fixture(t);
  await f.store.upsert([
    { anchor: 'thread-hidden', kind: 'thread', status: 'active', title: 'Hidden', updatedAt: '2026-01-01' },
  ]);
  const db = f.store.getDb();
  db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)').run(
    'thread-hidden',
    'msg-hidden',
    'needle hidden material',
    '2026-01-01T00:00:00Z',
  );
  new PassageVectorStore(db, 4).upsert(passageVectorKey('thread-hidden', 'msg-hidden'), new Float32Array([1, 0, 0, 0]));
  db.prepare(
    "INSERT INTO message_recall_index_suppressions(doc_anchor,passage_id,lease_id,state,prepared_at) VALUES (?,?,?,'prepared',?)",
  ).run('thread-visible', 'msg-b', 'isolated-lease', '2026-01-01');
  assert.equal(new PassageVectorStore(db, 4).count(), 4, 'suppression physically removes the old vector');
  const snapshots = [];
  const options = {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    sort: 'relevance',
    candidateOrder: 'relevance',
    candidateLimit: 5,
    excludeSource: { threadId: 'visible', messageId: 'c' },
  };
  const plain = await f.store.searchMessagePassages('needle', options);
  const observed = await f.store.searchMessagePassages('needle', {
    ...options,
    candidateAudit: auditRequest,
    onReadSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  assert.deepEqual(observed, plain);
  assert.ok(!observed.passages.some((row) => ['b', 'c', 'hidden'].includes(row.messageId)));
  const audit = snapshots.at(-1).candidateAudit;
  assert.equal(audit.nativeCount, 4, 'the native pool contains only the vectors remaining after suppression');
  for (const [anchor, id] of [
    ['thread-visible', 'b'],
    ['thread-visible', 'c'],
    ['thread-hidden', 'hidden'],
  ]) {
    const fingerprint = createHmac('sha256', auditRequest.key)
      .update(JSON.stringify(['message-candidate-audit', 1, 'message', anchor, `msg-${id}`]))
      .digest('hex')
      .slice(0, 32);
    assert.ok(!JSON.stringify(audit).includes(fingerprint));
  }
  assert.ok(audit.rows.filter((row) => row[0] === null).length >= 3);
});

test('observer failure and caller cancellation preserve actual worker completion and caller ownership', async (t) => {
  const f = await fixture(t);
  const caller = new AbortController();
  const options = {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    candidateAudit: auditRequest,
    signal: caller.signal,
  };
  const observed = await f.store.searchMessagePassages('needle', {
    ...options,
    onReadSnapshot() {
      throw new Error('observer fixture');
    },
  });
  assert.ok(observed.passages.length);
  assert.equal(caller.signal.aborted, false);
  const stop = new AbortController();
  const reason = new DOMException('controlled caller disconnect', 'AbortError');
  const waiting = f.store.searchMessagePassages('needle', {
    ...options,
    signal: stop.signal,
    onReadSnapshot() {
      throw new Error('observer fixture');
    },
  });
  stop.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  assert.equal(caller.signal.aborted, false);
  assert.ok(
    (await f.store.searchMessagePassages('needle', { visibleThreadIds: ['visible'], mode: 'lexical' })).passages.length,
  );
});
