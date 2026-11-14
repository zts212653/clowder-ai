import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { TasteObservatoryReader } from '../dist/domains/memory/taste/TasteObservatoryReader.js';
import { tasteBrowseRoutes } from '../dist/routes/taste-browse.js';

const sourcePath = 'docs/taste/vignettes/file-read.md';
const anchor = 'doc:taste/vignettes/file-read';
let root, db, file, invocations, readable, starts, onStart;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taste-file-read-'));
  file = join(root, 'evidence.sqlite');
  db = new Database(file);
  applyMigrations(db);
  mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
  writeFileSync(
    join(root, sourcePath),
    '---\nwhen: 2026-11-11\nquotes: ["approved"]\nscene: "test"\ntags: ["test"]\nprivacy: public\ncatId: codex61-sol\nproposalId: approved\n---\n',
  );
  invocations = new Map([['inv-owner', { userId: 'owner', threadId: 'thread-owner' }]]);
  readable = true;
  starts = [];
  onStart = (event) => {
    if (event.kind === 'taste-recall-read') starts.push(event);
  };
  channel('cat-cafe.memory-process').subscribe(onStart);
});

afterEach(() => {
  channel('cat-cafe.memory-process').unsubscribe(onStart);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function reader() {
  return new TasteObservatoryReader(
    db,
    { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
    'owner',
    { get: async (id) => invocations.get(id) ?? null },
    { get: async () => null },
    { get: async (id) => (id === 'thread-owner' ? { createdBy: 'owner' } : null) },
    { isReadable: () => readable },
  );
}

function append(id, invocation = 'inv-owner', candidates = [anchor], consumed = [], at = 100) {
  db.prepare(`INSERT INTO recall_events
    (recall_id, cat_id, invocation_id, tool_name, query, candidates_json, consumed_json,
     token_cost, timestamp, thread_id, source)
    VALUES (?, 'codex61-sol', ?, 'search_evidence', 'PRIVATE QUERY', ?, ?, 0, ?, 'thread-owner', 'pull')`).run(
    id,
    invocation,
    JSON.stringify(candidates.map((a) => ({ anchor: a }))),
    JSON.stringify(consumed.map((a) => ({ anchor: a }))),
    at,
  );
}

it('coalesces concurrent file-backed observatory reads without scanning recall JSON on the API connection', async () => {
  append('first', 'inv-owner', [anchor, anchor], [anchor]);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    assert.ok(!/FROM recall_events[\s\S]*candidates_json LIKE/.test(sql), 'broad recall scan belongs in the child');
    return prepare(sql);
  };
  const readers = [reader(), reader()];
  const snapshots = await Promise.all(Array.from({ length: 12 }, (_, i) => readers[i % 2].read('owner')));
  for (const snapshot of snapshots)
    assert.deepEqual(snapshot.entries[0].search, {
      hits: 1,
      opened: 1,
      unverified: 0,
      latest: { threadId: 'thread-owner', recalledAt: 100, opened: true },
    });
  assert.equal(starts.length, 1, 'one scan for concurrent consumers sharing the canonical database');
  assert.notEqual(starts[0].pid, process.pid);
});

it('caches observations briefly while rechecking invocation ownership and taste withdrawal on every read', async () => {
  append('first');
  const read = reader();
  assert.equal((await read.read('owner')).entries[0].search.hits, 1);
  invocations.set('inv-owner', { userId: 'foreign', threadId: 'thread-owner' });
  assert.equal((await read.read('owner')).entries[0].search.hits, 0, 'cached observations confer no ownership');
  readable = false;
  assert.equal((await read.read('owner')).entries.length, 0, 'withdrawn file is not a cached entry');
  assert.equal(starts.length, 1);
});

it('refreshes appended observations after the completion TTL and keeps owner projections separate', async () => {
  append('first');
  const read = reader();
  assert.equal((await read.read('owner')).entries[0].search.hits, 1);
  append('second', 'inv-owner', [anchor], [anchor], 200);
  assert.equal((await read.read('owner')).entries[0].search.hits, 1);
  await delay(1_100);
  const refreshed = await read.read('owner');
  assert.equal(refreshed.entries[0].search.hits, 2);
  assert.equal(refreshed.entries[0].search.latest.recalledAt, 200);
  assert.equal((await read.read('foreign')).entries[0].search.hits, 0);
  assert.equal(starts.length, 3);
});

it('does not cache child failures or fall back to a scan on the open parent connection', async () => {
  append('first');
  const read = reader();
  renameSync(file, `${file}.away`);
  await assert.rejects(read.read('owner'));
  renameSync(`${file}.away`, file);
  assert.equal((await read.read('owner')).entries[0].search.hits, 1);
});

it('preserves exact candidate/consumed deduplication, timestamp ties and unverified row accounting', async () => {
  append('a', 'inv-owner', [anchor, anchor], [anchor], 300);
  append('b', 'inv-owner', [anchor], [], 300);
  append('c', 'missing', [anchor, anchor], [anchor], 400);
  append('unrelated', 'missing', ['doc:other/PRIVATE BODY'], [], 500);
  const result = await reader().read('owner');
  assert.deepEqual(result.entries[0].search, {
    hits: 2,
    opened: 1,
    unverified: 1,
    latest: { threadId: 'thread-owner', recalledAt: 300, opened: false },
  });
  assert.equal(result.coverage.totalUnverified, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

it('serves authenticated list/detail fanout with one child read and keeps source withdrawal live', async (t) => {
  append('first', 'inv-owner', [anchor], [anchor]);
  const statistics = reader();
  let withdrawn = false;
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'];
  });
  await app.register(tasteBrowseRoutes, {
    ownerUserId: 'owner',
    tasteRepository: { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
    readObservatory: (owner, includePrivate) => statistics.read(owner, { includePrivate }),
    proposalStore: {
      get: async () => ({
        id: 'approved',
        userId: 'owner',
        status: 'approved',
        vignettePath: sourcePath,
        threadId: 'thread-owner',
        sourceMessageId: 'message-owner',
        createdAt: 100,
        approvedAt: 200,
      }),
    },
    threadStore: { get: async () => ({ id: 'thread-owner', createdBy: 'owner' }) },
    messageStore: {
      getById: async () => ({
        id: 'message-owner',
        threadId: 'thread-owner',
        userId: 'owner',
        catId: null,
        from: { kind: 'user', userId: 'owner' },
        content: 'approved',
        timestamp: 100,
        deliveryStatus: 'delivered',
        ...(withdrawn ? { deletedAt: 900 } : {}),
      }),
    },
  });
  const get = (url, owner = 'owner') => app.inject({ url, headers: { 'x-test-session': owner } });
  const list = await get('/api/memory/taste');
  assert.equal(list.statusCode, 200, list.body);
  const item = list.json().entries[0];
  const detail = `/api/memory/taste/${item.id}`;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => get(i % 2 ? detail : '/api/memory/taste')));
  for (const result of results) assert.equal(result.statusCode, 200, result.body);
  assert.equal(starts.length, 1);
  const source = `${detail}/source?revision=${item.revision}`;
  assert.equal((await get(source)).json().canOpen, true);
  withdrawn = true;
  assert.equal((await get(source)).json().canOpen, false, 'cached recall counters cannot retain a withdrawn source');
  assert.equal((await get(detail, 'foreign')).statusCode, 403);
  assert.equal(starts.length, 1, 'source and forbidden owner reads do not trigger observatory scans');
});
