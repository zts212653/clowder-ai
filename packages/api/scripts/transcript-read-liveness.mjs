// Run after API build: node scripts/transcript-read-liveness.mjs [fixture MiB, default 512].
// Uses generated temporary data, an ephemeral loopback HTTP port, and in-memory stores; no Redis/runtime access.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionTranscriptRoutes } from '../dist/routes/session-transcript.js';

const mib = Number(process.argv[2] ?? 512);
assert.ok(Number.isInteger(mib) && mib > 0 && mib <= 2048, 'fixture MiB must be 1..2048');
const root = await mkdtemp(join(tmpdir(), 'transcript-http-liveness-'));
const app = Fastify({ logger: false });
const sessions = new SessionChainStore();
const session = await sessions.create({ threadId: 'probe', catId: 'cat', userId: 'owner' });
const reader = new TranscriptReader({ dataDir: root });
const writer = new TranscriptWriter({ dataDir: root });
const directory = reader.getSessionDir(session.threadId, session.catId, session.id);
await mkdir(directory, { recursive: true });
const count = mib * 16;
try {
  const file = await open(join(directory, 'events.jsonl'), 'w');
  try {
    for (let i = 0; i < count; i++) {
      await file.write(
        `${JSON.stringify({
          v: 1,
          t: 1000 + i,
          threadId: session.threadId,
          catId: session.catId,
          sessionId: session.id,
          invocationId: `inv-${Math.floor(i / 64)}`,
          eventNo: i,
          event: { type: 'tool_result', content: 'x'.repeat(65536) },
        })}\n`,
      );
    }
  } finally {
    await file.close();
  }
  await app.register(sessionTranscriptRoutes, {
    invocationRecordStore: { get: async () => null },
    sessionChainStore: sessions,
    threadStore: { get: async () => ({ id: session.threadId, createdBy: 'owner' }), list: async () => [] },
    transcriptReader: reader,
    transcriptWriter: writer,
  });
  app.get('/health', async () => ({ ok: true }));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const health = [];
  let running = true;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const healthLoop = (async () => {
    while (running) {
      const start = performance.now();
      const response = await fetch(`${address}/health`);
      assert.equal(response.status, 200);
      await response.json();
      health.push(performance.now() - start);
      await delay(10);
    }
  })();
  const headers = { 'x-cat-cafe-user': 'owner' };
  const read = async (path) => {
    const start = performance.now();
    const response = await fetch(`${address}${path}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return { durationMs: performance.now() - start, body: await response.json() };
  };
  const before = process.memoryUsage();
  let evidence;
  try {
    const cold = await read('/api/threads/probe/invocations?limit=10');
    assert.equal(cold.body.total, Math.ceil(count / 64));
    assert.equal(cold.body.invocations.length, Math.min(10, Math.ceil(count / 64)));
    const warm = await read('/api/threads/probe/invocations?limit=10');
    assert.deepEqual(warm.body, cold.body);
    const last = `inv-${Math.floor((count - 1) / 64)}`;
    const detail = await read(`/api/sessions/${session.id}/invocations/${last}?limit=1`);
    assert.equal(detail.body.events.length, 1);
    const after = process.memoryUsage();
    evidence = {
      fixtureBytes: (await stat(join(directory, 'events.jsonl'))).size,
      events: count,
      total: cold.body.total,
      coldMs: cold.durationMs,
      warmMs: warm.durationMs,
      pagedDetailMs: detail.durationMs,
      parentHeapDeltaBytes: after.heapUsed - before.heapUsed,
      parentRssDeltaBytes: after.rss - before.rss,
    };
  } finally {
    running = false;
    await healthLoop;
    loop.disable();
  }
  evidence.healthSamples = health.length;
  evidence.healthMaxMs = Math.max(...health);
  evidence.eventLoopMaxMs = loop.max / 1e6;
  assert.ok(health.length > 5, 'health must be sampled throughout actual index work');
  assert.ok(evidence.healthMaxMs < 1000, `API health stalled: ${evidence.healthMaxMs}ms`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
