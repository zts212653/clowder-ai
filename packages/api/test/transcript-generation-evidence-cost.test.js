import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import {
  projectRequestGenerationGaps,
  projectRequestGenerations,
} from '../dist/domains/cats/services/session/transcript-index/RequestGenerationProjector.js';
import {
  readInvocationIndexInWorker,
  TranscriptInvocationReader,
} from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';

const invocationId = 'evidence-invocation';
const session = { id: 'evidence-session', threadId: 'evidence-thread', catId: 'codex61-sol', seq: 0, status: 'active' };
function event(n, payload) {
  return {
    v: 1,
    t: 1000 + n,
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId,
    eventNo: n,
    event: payload,
  };
}
function assembled(n) {
  return {
    type: 'request_generation_assembled',
    envelope: {
      v: 1,
      invocationId,
      sessionId: session.id,
      generationOrdinal: n,
      requestGenerationId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      promptGenerationId: `hmac-sha256:${'a'.repeat(64)}`,
      assembledAt: n,
      continuity: { capability: 'unknown', compactionRefs: [] },
      channels: [
        {
          channel: 'message',
          accuracy: 'exact',
          keyedContentDigest: `hmac-sha256:${'a'.repeat(64)}`,
          byteLength: 6,
          body: 'secret',
          sourceRefs: [],
        },
      ],
      presentations: [],
      runtime: { requested: { provider: 'openai', carrier: 'app_server' }, providerNativeVisibility: 'unknown' },
      tools: { finalSurface: 'unknown' },
      retryBoundary:
        n === 1 ? { attempt: 1 } : { attempt: n, previousGenerationOrdinal: n - 1, reason: 'missing_session' },
    },
  };
}
function assertEvidence(full, evidence) {
  assert.equal(evidence.total, full.total, 'presence/count must not invent a missing invocation');
  assert.deepEqual(
    evidence.events.map(({ invocationId, sessionId, eventNo, t }) => ({ invocationId, sessionId, eventNo, t })),
    full.events.map(({ invocationId, sessionId, eventNo, t }) => ({ invocationId, sessionId, eventNo, t })),
  );
  assert.deepEqual(
    evidence.events.filter((e) => String(e.event.type).startsWith('request_generation_')),
    full.events.filter((e) => String(e.event.type).startsWith('request_generation_')),
  );
  assert.deepEqual(projectRequestGenerations(evidence.events), projectRequestGenerations(full.events));
  assert.deepEqual(projectRequestGenerationGaps(evidence.events), projectRequestGenerationGaps(full.events));
  assert.ok(
    Buffer.byteLength(JSON.stringify(evidence.events)) < 20_000,
    'canonical evidence must not transfer unrelated large tool/output bodies into the parent',
  );
  assert.equal(JSON.stringify(evidence.events).includes('large-tool-canary'), false);
}

for (const status of ['active', 'sealed']) {
  test(`${status} canonical evidence keeps generation integrity and presence without full tool payload IPC`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'task229-evidence-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const reader = new TranscriptReader({ dataDir: dir });
    const index = new TranscriptInvocationReader(reader);
    const scope = { ...session, status };
    const path = reader.getSessionDir(session.threadId, session.catId, session.id);
    await mkdir(path, { recursive: true });
    const rows = [
      event(0, { type: 'tool_result', content: 'large-tool-canary'.repeat(100_000) }),
      event(1, assembled(1)),
      event(2, { type: 'request_generation_future', extension: 'must-retain' }),
    ];
    await writeFile(
      join(path, status === 'active' ? 'events.live.jsonl' : 'events.jsonl'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    const full = (await index.readInvocation([scope], invocationId)).get(session.id);
    const projected = (await index.readInvocation([scope], invocationId, { generationEvidenceOnly: true })).get(
      session.id,
    );
    const workerResult = await readInvocationIndexInWorker({
      sessions: [{ session: scope, directory: path, buffered: [], includeLive: status === 'active' }],
      query: { kind: 'invocation', invocationId, generationEvidenceOnly: true },
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(workerResult)) < 20_000,
      'the worker result itself must be compact before process IPC, not clipped afterwards by the parent',
    );
    assertEvidence(full, projected);
    assert.equal(full.events[0].event.content, rows[0].event.content, 'full/raw consumers remain exact');
  });
}

test('buffer-backed generation evidence remains fresh and preserves malformed generation failures', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'task229-evidence-buffer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = new TranscriptWriter({ dataDir: dir });
  const reader = new TranscriptInvocationReader(new TranscriptReader({ dataDir: dir }), writer);
  const coordinate = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: session.seq };
  writer.appendEvent(coordinate, { type: 'tool_result', content: 'large-tool-canary'.repeat(100_000) }, invocationId);
  writer.appendEvent(coordinate, assembled(1), invocationId);
  const read = async (options = {}) => (await reader.readInvocation([session], invocationId, options)).get(session.id);
  assertEvidence(await read(), await read({ generationEvidenceOnly: true }));
  writer.appendEvent(coordinate, assembled(2), invocationId);
  const fresh = await read({ generationEvidenceOnly: true });
  assert.deepEqual(
    projectRequestGenerations(fresh.events).map((g) => g.envelope.generationOrdinal),
    [1, 2],
  );
  writer.appendEvent(coordinate, { type: 'request_generation_assembled', envelope: { malformed: true } }, invocationId);
  const malformed = await read({ generationEvidenceOnly: true });
  assert.throws(() => projectRequestGenerations(malformed.events));
});
