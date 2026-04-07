import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

/**
 * Minimal TranscriptWriter mock: flush writes a digest to our fake reader.
 */
function createMockTranscriptWriter(fakeReader) {
  return {
    appendEvent() {},
    flush(session, timestamps) {
      // Store digest that the fakeReader will return
      const digest = {
        v: 1,
        sessionId: session.sessionId,
        threadId: session.threadId,
        catId: session.catId,
        seq: session.seq,
        time: timestamps,
        invocations: [{ toolNames: ['Edit', 'Read'] }],
        filesTouched: [{ path: 'src/index.ts', ops: ['edit'] }],
        errors: [],
      };
      fakeReader._digestStore.set(`${session.threadId}/${session.catId}/${session.sessionId}`, digest);
    },
  };
}

function createMockTranscriptReader() {
  const reader = {
    _digestStore: new Map(),
    async readDigest(sessionId, threadId, catId) {
      return reader._digestStore.get(`${threadId}/${catId}/${sessionId}`) ?? null;
    },
    async readEvents() {
      return { events: [], total: 0 };
    },
    async search() {
      return [];
    },
    async readInvocationEvents() {
      return null;
    },
    async hasTranscript() {
      return false;
    },
  };
  return reader;
}

// --- VG-3: Mock summaryStore + event-producing reader for decision signals ---

function createMockSummaryStore(summaries = []) {
  return {
    listByThread() {
      return summaries;
    },
  };
}

function createDecisionAwareReader(digestStore, events = []) {
  return {
    _digestStore: digestStore,
    async readDigest(sessionId, threadId, catId) {
      return digestStore.get(`${threadId}/${catId}/${sessionId}`) ?? null;
    },
    async readAllEvents() {
      return events;
    },
    async readEvents() {
      return { events: [], total: 0 };
    },
    async search() {
      return [];
    },
    async readInvocationEvents() {
      return null;
    },
    async hasTranscript() {
      return false;
    },
  };
}

describe('SessionSealer — ThreadMemory integration', () => {
  let chainStore;
  let threadStore;
  let fakeReader;
  let fakeWriter;
  let sealer;

  beforeEach(() => {
    chainStore = new SessionChainStore();
    threadStore = new ThreadStore();
    fakeReader = createMockTranscriptReader();
    fakeWriter = createMockTranscriptWriter(fakeReader);

    sealer = new SessionSealer(
      chainStore,
      fakeWriter,
      threadStore,
      fakeReader,
      () => 180000, // Opus maxPromptTokens
    );
  });

  it('updates ThreadMemory on finalize', async () => {
    // Create thread + session
    const thread = threadStore.create('user1', 'test thread');
    const session = chainStore.create({
      cliSessionId: 'cli-1',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    // Request seal + finalize
    await sealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: session.id });

    // Check thread memory was created
    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem, 'ThreadMemory should exist after seal');
    assert.equal(mem.v, 1);
    assert.equal(mem.sessionsIncorporated, 1);
    assert.ok(mem.summary.includes('Session #1'));
    assert.ok(mem.summary.includes('Modified: src/index.ts'));
  });

  it('accumulates across multiple seals', async () => {
    const thread = threadStore.create('user1', 'multi-seal');

    // Seal session 1
    const s1 = chainStore.create({
      cliSessionId: 'cli-1',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });
    await sealer.requestSeal({ sessionId: s1.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: s1.id });

    // Seal session 2
    const s2 = chainStore.create({
      cliSessionId: 'cli-2',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });
    await sealer.requestSeal({ sessionId: s2.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: s2.id });

    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem);
    assert.equal(mem.sessionsIncorporated, 2);
    assert.ok(mem.summary.includes('Session #2'));
    assert.ok(mem.summary.includes('Session #1'));
  });

  it('still seals when ThreadMemory update fails', async () => {
    // Use a threadStore that throws on updateThreadMemory
    const brokenThreadStore = new ThreadStore();
    brokenThreadStore.updateThreadMemory = () => {
      throw new Error('boom');
    };

    const brokenSealer = new SessionSealer(chainStore, fakeWriter, brokenThreadStore, fakeReader, () => 180000);

    const thread = brokenThreadStore.create('user1', 'broken');
    const session = chainStore.create({
      cliSessionId: 'cli-3',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    await brokenSealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await brokenSealer.finalize({ sessionId: session.id });

    // Session should still be sealed despite ThreadMemory failure
    const record = chainStore.get(session.id);
    assert.equal(record.status, 'sealed');
  });

  it('uses dynamic token cap based on getMaxPromptTokens', async () => {
    // Spark: 64k → cap = max(1200, min(3000, floor(64000*0.03))) = max(1200,1920) = 1920
    const sparkSealer = new SessionSealer(chainStore, fakeWriter, threadStore, fakeReader, () => 64000);

    const thread = threadStore.create('user1', 'spark');
    const session = chainStore.create({
      cliSessionId: 'cli-4',
      threadId: thread.id,
      catId: 'spark',
      userId: 'user1',
    });
    await sparkSealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sparkSealer.finalize({ sessionId: session.id });

    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem);
    // Can't directly test the cap, but we verify it doesn't crash
    assert.equal(mem.sessionsIncorporated, 1);
  });
});

// --- VG-3: Decision signals wiring through SessionSealer ---

describe('SessionSealer — VG-3 DecisionSignals wiring', () => {
  let chainStore;
  let threadStore;

  beforeEach(() => {
    chainStore = new SessionChainStore();
    threadStore = new ThreadStore();
  });

  it('extracts decisions from summaryStore and writes to threadMemory', async () => {
    const digestStore = new Map();
    const events = [
      { t: 1000, event: { type: 'text', content: [{ type: 'text', text: '我们决定用方案B。确定了redis端口6398。' }] } },
    ];
    const reader = createDecisionAwareReader(digestStore, events);
    const writer = createMockTranscriptWriter(reader);

    const summaryStore = createMockSummaryStore([
      { id: 'sum1', threadId: 't1', conclusions: ['选择了分层传输'], openQuestions: ['阈值待定'], createdAt: 1000 },
    ]);

    const sealer = new SessionSealer(
      chainStore,
      writer,
      threadStore,
      reader,
      () => 180000,
      undefined, // handoffConfig
      summaryStore,
    );

    const thread = threadStore.create('user1', 'decision thread');
    const session = chainStore.create({
      cliSessionId: 'cli-vg3-1',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    await sealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: session.id });

    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem, 'ThreadMemory should exist');
    assert.ok(mem.decisions?.length > 0, `expected decisions, got: ${JSON.stringify(mem.decisions)}`);
    assert.ok(mem.decisions.some((d) => d.includes('分层传输') || d.includes('方案B')));
    assert.ok(mem.openQuestions?.length > 0, `expected openQuestions, got: ${JSON.stringify(mem.openQuestions)}`);
  });

  it('works without summaryStore (backward compat)', async () => {
    const digestStore = new Map();
    const events = [{ t: 1000, event: { type: 'text', content: [{ type: 'text', text: '我们决定用方案B。' }] } }];
    const reader = createDecisionAwareReader(digestStore, events);
    const writer = createMockTranscriptWriter(reader);

    // No summaryStore — 7th param undefined
    const sealer = new SessionSealer(
      chainStore,
      writer,
      threadStore,
      reader,
      () => 180000,
      undefined, // handoffConfig
      undefined, // summaryStore — not available
    );

    const thread = threadStore.create('user1', 'no-summary');
    const session = chainStore.create({
      cliSessionId: 'cli-vg3-2',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    await sealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: session.id });

    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem, 'ThreadMemory should exist');
    // Regex-only extraction should still find decisions from transcript text
    assert.ok(
      mem.decisions?.some((d) => d.includes('方案B')),
      `regex should find 方案B: ${JSON.stringify(mem.decisions)}`,
    );
  });

  it('P2: extracts signals when only openQuestions in summary (no transcript, no conclusions)', async () => {
    const digestStore = new Map();
    const events = []; // no transcript events
    const reader = createDecisionAwareReader(digestStore, events);
    const writer = createMockTranscriptWriter(reader);

    // Summary has ONLY openQuestions, no conclusions
    const summaryStore = createMockSummaryStore([
      { id: 'sum1', threadId: 't1', conclusions: [], openQuestions: ['阈值待定', 'burst gap 怎么算'], createdAt: 1000 },
    ]);

    const sealer = new SessionSealer(chainStore, writer, threadStore, reader, () => 180000, undefined, summaryStore);

    const thread = threadStore.create('user1', 'openq-only');
    const session = chainStore.create({
      cliSessionId: 'cli-vg3-p2',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    await sealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: session.id });

    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem, 'ThreadMemory should exist');
    assert.ok(mem.openQuestions?.length > 0, `expected openQuestions, got: ${JSON.stringify(mem.openQuestions)}`);
  });

  it('still seals when decision extraction fails', async () => {
    const digestStore = new Map();
    // Events that would cause extraction but we'll break the reader
    const brokenReader = createDecisionAwareReader(digestStore, []);
    brokenReader.readAllEvents = () => {
      throw new Error('event read failed');
    };
    const writer = createMockTranscriptWriter(brokenReader);

    const sealer = new SessionSealer(
      chainStore,
      writer,
      threadStore,
      brokenReader,
      () => 180000,
      undefined,
      createMockSummaryStore(),
    );

    const thread = threadStore.create('user1', 'broken-events');
    const session = chainStore.create({
      cliSessionId: 'cli-vg3-3',
      threadId: thread.id,
      catId: 'opus',
      userId: 'user1',
    });

    await sealer.requestSeal({ sessionId: session.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: session.id });

    // Should still seal despite decision extraction failure
    const record = chainStore.get(session.id);
    assert.equal(record.status, 'sealed');
    // ThreadMemory should still exist (from digest, just without decisions)
    const mem = threadStore.getThreadMemory(thread.id);
    assert.ok(mem, 'ThreadMemory should exist even if decision extraction fails');
  });
});
