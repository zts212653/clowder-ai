import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createServer } from '../../mcp-server/dist/index.js';
import { useInvocationAuth } from '../../mcp-server/test/helpers/invocation-auth.js';
import { RecallMetricsComputer } from '../dist/domains/memory/RecallMetricsComputer.js';
import { RecallMetricsReader } from '../dist/domains/memory/RecallMetricsReader.js';
import { applyMigrations, SCHEMA_V1 } from '../dist/domains/memory/schema.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackRecallMetrics } from '../dist/routes/callback-recall-metrics.js';
import { clearRecallMetricsCache, recallMetricsRoutes } from '../dist/routes/recall-metrics.js';

test('canonical cache misses leave the API event loop available to light HTTP requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f306-metrics-loop-red-'));
  const db = new Database(join(root, 'fixture.sqlite'));
  db.exec(SCHEMA_V1);
  db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
  applyMigrations(db);
  const app = Fastify();
  let entered;
  const entry = new Promise((resolve) => {
    entered = resolve;
  });
  let heavyStarted;
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/recall/metrics')) {
      heavyStarted = performance.now();
      entered();
    }
  });
  app.get('/light', async () => ({ ok: true }));
  await app.register(recallMetricsRoutes, { evidenceDb: db });
  const compute = RecallMetricsComputer.prototype.computeMetrics;
  t.mock.method(RecallMetricsComputer.prototype, 'computeMetrics', function (...args) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    return compute.apply(this, args);
  });
  clearRecallMetricsCache();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const heavy = fetch(`${url}/api/recall/metrics?days=90`, { headers: { 'X-Cat-Cafe-User': 'default-user' } });
  try {
    await entry;
    assert.deepEqual(await (await fetch(`${url}/light`)).json(), { ok: true });
    const lag = performance.now() - heavyStarted;
    console.log(JSON.stringify({ lightRequestFromHeavyEntryMs: lag }));
    assert.ok(lag < 500, 'the API process must not run the synchronous metrics computation');
    assert.equal((await heavy).status, 200);
  } finally {
    await heavy;
    await app.close();
    db.close();
    clearRecallMetricsCache();
    await rm(root, { recursive: true, force: true });
  }
});

function observeChildren(t) {
  const children = [];
  const fork = childProcess.fork;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = fork(...args);
    children.push({ child, exited: new Promise((resolve) => child.once('exit', resolve)) });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return children;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'f306-metrics-process-'));
  const path = join(root, 'evidence.sqlite');
  const db = new Database(path);
  db.exec(SCHEMA_V1);
  db.prepare('INSERT INTO schema_version(version, applied_at) VALUES (1, ?)').run(new Date().toISOString());
  applyMigrations(db);
  db.prepare(`INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
    candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
    next_graph_resolve_after_read, token_cost, timestamp)
    VALUES ('seed', 'codex61-sol', 'fixture', 'cat_cafe_search_evidence', 'private', 'hybrid', 'docs',
      '[]', '[]', 0, 0, 0, 0, 0, ?)`).run(Date.now());
  db.pragma('busy_timeout=0');
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, path };
}

function makeNativeQuerySlow(db) {
  db.exec(`ALTER TABLE recall_events RENAME TO metrics_seed;
    CREATE VIEW recall_events AS SELECT metrics_seed.*,
      (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000)
       SELECT sum(x) FROM n) AS deliberate_native_work FROM metrics_seed;`);
}

function restoreNativeQuery(db) {
  db.exec('DROP VIEW recall_events; ALTER TABLE metrics_seed RENAME TO recall_events;');
}

async function waitForNativeRead(db) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    try {
      db.exec('BEGIN EXCLUSIVE; ROLLBACK;');
    } catch (error) {
      if (error.code === 'SQLITE_BUSY') return;
      throw error;
    }
    await delay(10);
  }
  throw new Error('the actual readonly child did not enter its native SQLite read');
}

async function assertChildrenExited(children) {
  for (const { child, exited } of children) {
    let timer;
    try {
      await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('owned metrics child did not exit')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }
}

test('missing and in-memory sources fail without creating a database or computing inline', async (t) => {
  const { path } = await fixture(t);
  const missing = join(path, '..', 'missing.sqlite');
  let inlineCalls = 0;
  t.mock.method(RecallMetricsComputer.prototype, 'computeMetrics', () => {
    inlineCalls++;
    assert.fail('inline fallback');
  });
  await assert.rejects(new RecallMetricsReader(missing).read({ days: 30 }, new AbortController().signal));
  await assert.rejects(access(missing), { code: 'ENOENT' });
  await assert.rejects(
    new RecallMetricsReader(':memory:').read({ days: 30 }, new AbortController().signal),
    /file-backed/,
  );
  assert.equal(inlineCalls, 0);
});

test('isolated reader uses the same computation and fixed time, keeps cache, and fails without caching', async (t) => {
  const { db, path } = await fixture(t);
  const children = observeChildren(t);
  const reader = new RecallMetricsReader(path);
  const fixed = Date.now();
  t.mock.method(Date, 'now', () => fixed);
  const query = { days: 30, catId: 'codex61-sol', toolName: 'cat_cafe_search_evidence' };
  const expected = new RecallMetricsComputer(db).computeMetrics({ ...query, toMs: fixed });
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  assert.deepEqual(await reader.read(query, new AbortController().signal), expected);
  assert.deepEqual(await reader.read(query, new AbortController().signal), expected);
  assert.equal(children.length, 1, 'the shared sixty-second cache avoids another process');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  clearRecallMetricsCache();
  db.exec("UPDATE recall_events SET candidates_json='not-json';");
  await assert.rejects(reader.read(query, new AbortController().signal));
  db.exec("UPDATE recall_events SET candidates_json='[]';");
  assert.deepEqual(await reader.read(query, new AbortController().signal), expected);
  assert.equal(children.length, 3, 'a failed projection is not cached or retried inline');
  await assertChildrenExited(children);
});

test('native query timeout kills its process and permits the next query', async (t) => {
  const { db, path } = await fixture(t);
  const children = observeChildren(t);
  makeNativeQuerySlow(db);
  const reader = new RecallMetricsReader(path, 3500);
  const failure = assert.rejects(reader.read({ days: 90 }, new AbortController().signal), /timed out/);
  await waitForNativeRead(db);
  await failure;
  await assertChildrenExited(children);
  restoreNativeQuery(db);
  assert.equal((await reader.read({ days: 30 }, new AbortController().signal)).totalEvents, 1);
  await assertChildrenExited(children);
});

test('cancelled private jobs and queued deadlines preserve the shared pool and other callers', async (t) => {
  const { db, path } = await fixture(t);
  const children = observeChildren(t);
  makeNativeQuerySlow(db);
  const reader = new RecallMetricsReader(path);
  const first = new AbortController();
  const second = new AbortController();
  const a = assert.rejects(reader.read({ days: 90 }, first.signal), /first cancelled/);
  const b = assert.rejects(reader.read({ days: 90 }, second.signal), /second cancelled/);
  while (children.length < 2) await delay(5);
  await waitForNativeRead(db);
  await assert.rejects(new RecallMetricsReader(path, 50).read({ days: 30 }, new AbortController().signal), /timed out/);
  assert.equal(children.length, 2, 'a queued deadline includes waiting and starts no extra process');
  first.abort(new Error('first cancelled'));
  await a;
  await assertChildrenExited(children.slice(0, 1));
  assert.equal(children[1].child.exitCode, null);
  assert.equal(children[1].child.signalCode, null, 'one same-query caller cannot cancel another caller');
  second.abort(new Error('second cancelled'));
  await b;
  await assertChildrenExited(children);
  restoreNativeQuery(db);
  assert.equal((await reader.read({ days: 30 }, new AbortController().signal)).totalEvents, 1);
  await assertChildrenExited(children);
});

test('MCP cancellation crosses callback and canonical GET while light requests stay live', async (t) => {
  const { db } = await fixture(t);
  const children = observeChildren(t);
  useInvocationAuth(t);
  const originalUrl = process.env.CAT_CAFE_API_URL;
  const app = Fastify();
  app.get('/light', async () => ({ ok: true }));
  registerCallbackAuthHook(app, {
    verify: async (id, token) =>
      id === 'metrics-inv' && token === 'metrics-token'
        ? {
            ok: true,
            record: {
              invocationId: id,
              callbackToken: token,
              userId: 'default-user',
              catId: 'codex61-sol',
              threadId: 'fixture',
            },
          }
        : { ok: false, reason: 'invalid_token' },
  });
  await app.register(recallMetricsRoutes, { evidenceDb: db });
  await registerCallbackRecallMetrics(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  process.env.CAT_CAFE_API_URL = url;
  process.env.CAT_CAFE_INVOCATION_ID = 'metrics-inv';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'metrics-token';
  const controller = new AbortController();
  makeNativeQuerySlow(db);
  const tool = createServer()._registeredTools.cat_cafe_get_recall_metrics;
  let done = false;
  const heavy = tool.handler({ days: 90 }, { signal: controller.signal }).then((result) => {
    done = true;
    return result;
  });
  try {
    await waitForNativeRead(db);
    assert.deepEqual(await (await fetch(`${url}/light`)).json(), { ok: true });
    assert.equal(done, false, 'ordinary HTTP completes before the heavy native query');
    controller.abort();
    assert.equal((await heavy).isError, true);
    await assertChildrenExited(children);
    restoreNativeQuery(db);
    const next = await tool.handler({ days: 30 }, { signal: new AbortController().signal });
    assert.equal(next.isError, undefined);
    assert.equal(JSON.parse(next.content[0].text).totalEvents, 1);
    await assertChildrenExited(children);
  } finally {
    controller.abort();
    await heavy;
    await app.close();
    if (originalUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = originalUrl;
  }
});
