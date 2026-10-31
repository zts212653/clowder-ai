import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import * as sqliteVec from 'sqlite-vec';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { IndexBuilder } from '../src/domains/memory/IndexBuilder.ts';
import { PassageVectorStore, passageVectorKey } from '../src/domains/memory/PassageVectorStore.ts';
import { SqliteEvidenceStore } from '../src/domains/memory/SqliteEvidenceStore.ts';
import { ensurePassageVectorTable, ensureVectorTable } from '../src/domains/memory/schema.ts';
import { VectorStore } from '../src/domains/memory/VectorStore.ts';

// Run only through run-isolated-redis-tests.mjs. This measures real storage/index
// work with synthetic messages; it never contacts a provider or an Alpha/runtime.
const endpoint = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6399');
assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1');
assert.equal(endpoint.hostname, '127.0.0.1');
assert.ok(![6397, 6398, 6399, 6401].includes(Number(endpoint.port)));
const runId = randomUUID();
const keyPrefix = `f322-freshness:${runId}:`;
const redis = createRedisClient({ url: endpoint.href, keyPrefix });
const verifier = createRedisClient({ url: endpoint.href, keyPrefix });
const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
const durableReader = new RedisMessageStore(verifier, { ttlSeconds: 0 });
const root = mkdtempSync(resolve(tmpdir(), 'f322-freshness-'));
const docs = resolve(root, 'docs');
mkdirSync(resolve(docs, 'features'), { recursive: true });
const stores = [];
const report = {
  schemaVersion: 1,
  status: 'running',
  runId,
  recordedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  source: 'isolated RedisMessageStore append → IndexBuilder dirty flush → SQLite passage FTS/vector',
  providerLatency: 'unknown: no real embedding provider invoked',
  sourceHashes: Object.fromEntries(
    [import.meta.url, new URL('../src/domains/memory/IndexBuilder.ts', import.meta.url).href].map((url) => [
      fileURLToPath(url),
      createHash('sha256')
        .update(readFileSync(fileURLToPath(url)))
        .digest('hex'),
    ]),
  ),
  cases: [],
};

function saveReport() {
  const snapshot = structuredClone(report);
  for (const entry of snapshot.cases) {
    entry.sampleCount = entry.samples.length;
    for (const sample of entry.samples) delete sample.started;
  }
  const dir = fileURLToPath(new URL('../../../.cat-cafe/tmp/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const raw = `${JSON.stringify(snapshot, null, 2)}\n`;
  writeFileSync(resolve(dir, `f322-message-index-freshness-${runId}.json`), raw);
  writeFileSync(resolve(dir, 'f322-message-index-freshness.json'), raw);
}

async function setup(name, embeddingDelayMs) {
  const store = new SqliteEvidenceStore(resolve(root, `${name}.sqlite`));
  stores.push(store);
  await store.initialize();
  const thread = { id: `thread-${name}-${runId}`, title: name, participants: [], lastActiveAt: Date.now() };
  let deps;
  if (embeddingDelayMs !== undefined) {
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    ensurePassageVectorTable(db, 4);
    deps = {
      vectorStore: new VectorStore(db, 4),
      passageVectorStore: new PassageVectorStore(db, 4),
      embedding: {
        load: async () => {},
        reprobeIfNeeded: async () => {},
        dispose: () => {},
        isReady: () => true,
        embed: async (texts) => {
          await delay(embeddingDelayMs);
          return texts.map(() => new Float32Array([1, 0, 0, 0]));
        },
        getModelInfo: () => ({ modelId: 'controlled-fixture', modelRev: '1', dim: 4 }),
      },
    };
  }
  const builder = new IndexBuilder(
    store,
    docs,
    deps,
    undefined,
    () => [thread],
    (id, limit) => messages.getByThread(id, limit, 'f322-probe-owner'),
  );
  messages.onAppend = (message) => {
    thread.lastActiveAt = message.timestamp;
    builder.markThreadDirty(message.threadId);
    builder.accumulateSummaryDelta(message.threadId, message.content);
  };
  return { store, thread, builder, deps };
}

async function appendSample(thread, sampleNumber) {
  const query = `f322fresh${runId.replaceAll('-', '')}sample${sampleNumber}`;
  const started = performance.now();
  const message = await messages.append({
    userId: 'f322-probe-owner',
    catId: null,
    threadId: thread.id,
    content: query,
    mentions: [],
    timestamp: Date.now(),
  });
  assert.equal((await durableReader.getById(message.id))?.content, query);
  assert.equal(await redis.ttl(`msg:${message.id}`), -1, 'source message has no expiry');
  return {
    messageId: message.id,
    query,
    messageTimestamp: message.timestamp,
    persistedAt: new Date().toISOString(),
    started,
    persistAckMs: performance.now() - started,
  };
}

function captureReadiness(context, sample) {
  sample.queryCount = (sample.queryCount ?? 0) + 1;
  sample.lastQueryAt = new Date().toISOString();
  const hits = context.store.searchPassages(sample.query);
  if (sample.lexicalReadyMs === undefined && hits.some((hit) => hit.passageId === `msg-${sample.messageId}`)) {
    sample.lexicalReadyMs = performance.now() - sample.started;
    sample.lexicalReadyAt = new Date().toISOString();
  }
  if (context.deps && sample.vectorReadyMs === undefined) {
    const hit = context.store
      .getDb()
      .prepare('SELECT 1 AS present FROM passage_vectors WHERE passage_key=?')
      .get(passageVectorKey(`thread-${context.thread.id}`, `msg-${sample.messageId}`));
    if (hit) {
      sample.vectorReadyMs = performance.now() - sample.started;
      sample.vectorReadyAt = new Date().toISOString();
    }
  }
}

async function observe(context, samples, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    for (const sample of samples) captureReadiness(context, sample);
    if (
      samples.every(
        (sample) => sample.lexicalReadyMs !== undefined && (!context.deps || sample.vectorReadyMs !== undefined),
      )
    )
      return;
    await delay(10);
  }
  throw new Error('freshness observation deadline exhausted');
}

try {
  await redis.ping();
  await verifier.ping();
  const baseline = await setup('configured-30s-no-provider');
  const samples = [];
  const baselineCase = {
    name: 'configured-30s-no-provider',
    configuredTriggerMs: 30_000,
    semantic: 'unavailable; latency unknown',
    samples,
  };
  report.cases.push(baselineCase);
  let flushError;
  let flushStartedAt;
  let flushPromise;
  const timer = setInterval(() => {
    flushStartedAt = new Date().toISOString();
    baselineCase.flushStartedAt = flushStartedAt;
    flushPromise = baseline.builder.flushDirtyThreads().catch((error) => {
      flushError = error;
    });
  }, 30_000);
  try {
    for (let i = 0; i < 3; i++) {
      samples.push(await appendSample(baseline.thread, i));
      saveReport();
      if (i < 2) await delay(1000);
    }
    await observe(baseline, samples, 35_000);
    await flushPromise;
    if (flushError) throw flushError;
    saveReport();
  } finally {
    clearInterval(timer);
  }

  const controlled = await setup('controlled-embedding-backlog', 250);
  const sample = await appendSample(controlled.thread, 3);
  report.cases.push({
    name: 'controlled-embedding-backlog',
    fixtureEmbeddingDelayMs: 250,
    semantic: 'fixture vector readiness only; not provider latency',
    samples: [sample],
  });
  saveReport();
  const flush = controlled.builder.flushDirtyThreads();
  await observe(controlled, [sample], 5000);
  await flush;
  report.status = 'complete';
  saveReport();
  console.log(JSON.stringify({ runId, status: report.status, cases: report.cases }));
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  saveReport();
  throw error;
} finally {
  for (const store of stores) store.close();
  await Promise.allSettled([redis.quit(), verifier.quit()]);
  rmSync(root, { recursive: true, force: true });
}
